import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { EventBus, JsonlSessionStore, OpenAICompatibleProvider, runTurn } from "./turn-runtime.mjs";
import { NativeToolRegistry, openAiTools, toolText } from "../tools/registry.mjs";
import { createDelegateSubagentsTool } from "../agents/subagents.mjs";
import { assertAgentSession, normalizeDisplayMessages } from "./agent-session.mjs";
import { ToolReceiptStore } from "../tools/receipts.mjs";
import { boundedAuditValue } from "./events.mjs";

class OfflineProvider {
  constructor(model = "offline") { this.model = model; }
  async *stream() {
    yield { type: "text_delta", delta: "Offline mode: configure OPENAI_MODEL and OPENAI_BASE_URL (plus OPENAI_API_KEY when required) to connect a provider." };
    yield { type: "finish", reason: "stop" };
  }
}

export function providerFromEnvironment(env = process.env, fetchImpl = globalThis.fetch) {
  const configured = Boolean(env.OPENAI_MODEL || env.OPENAI_BASE_URL || env.OPENAI_API_KEY);
  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  if (env.SANDORA_OFFLINE === "1" || !configured) return new OfflineProvider("offline");
  return new OpenAICompatibleProvider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1", model, fetchImpl });
}

async function repairIncompleteToolTranscript(store, events) {
  const messages = events.filter(event => ["user.message.accepted", "assistant.message.completed", "tool.result.recorded"].includes(event.type)).map(event => event.payload?.message).filter(Boolean);
  const pending = new Map();
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.tool_calls || []) if (call?.id) pending.set(call.id, call);
    if (message.role === "tool" && message.tool_call_id) pending.delete(message.tool_call_id);
  }
  for (const [toolCallId, call] of pending) {
    const message = { role: "tool", tool_call_id: toolCallId, content: JSON.stringify({ error: "Tool execution outcome was not durably recorded before restart", recoveryGenerated: true, ambiguousExternalEffect: true }) };
    await store.append({ type: "tool.result.recorded", message, recoveryGenerated: true });
    await store.append({ type: "recovery.tool_result_synthesized", toolCallId, toolName: call.function?.name || "unknown", status: "AMBIGUOUS" });
    messages.push(message);
  }
  return messages;
}

export async function createAgentSession({
  cwd = process.cwd(),
  sessionPath = join(cwd, ".sandora", "session.jsonl"),
  provider = providerFromEnvironment(),
  registry = new NativeToolRegistry(),
  systemPrompt = "You are Sandora Agent.",
  maxSteps = 12,
} = {}) {
  const store = new JsonlSessionStore(sessionPath);
  const bus = new EventBus();
  const events = await store.replay();
  const resumed = await repairIncompleteToolTranscript(store, events);
  const existingSession = events.find(event => event.type === "session.created");
  const modelId = provider.model || "custom";
  const systemPromptSha256 = createHash("sha256").update(systemPrompt).digest("hex");
  const persistedPromptSha256 = existingSession?.payload?.systemPromptSha256;
  const persistedModel = existingSession?.payload?.model;
  if (existingSession && ((persistedPromptSha256 !== undefined && persistedPromptSha256 !== systemPromptSha256) || (persistedModel !== undefined && persistedModel !== modelId))) throw new Error("native session identity does not match persisted session");
  const sessionId = existingSession?.payload?.sessionId || randomUUID();
  const receipts = new ToolReceiptStore({ cwd, sessionId, runtime: "native" });
  await store.append({ type: existingSession ? "session.resumed" : "session.created", sessionId, runtime: "sandora-native", model: modelId, systemPromptSha256 });
  const messages = [{ role: "system", content: systemPrompt }, ...resumed.filter(message => message?.role !== "system")];
  if (!registry.has("delegate_subagents")) registry.register(createDelegateSubagentsTool({ provider, cwd }));
  let active;
  const session = {
    runtime: "native",
    sessionId,
    thinkingLevel: undefined,
    model: { id: modelId },
    getContextUsage: () => ({ tokens: Math.ceil(JSON.stringify(messages).length / 4) }),
    getLastAssistantText: () => messages.findLast(message => message?.role === "assistant")?.content,
    getDisplayMessages: () => normalizeDisplayMessages(messages),
    subscribe(listener) {
      const unsubs = [
        bus.on("agent", listener),
        bus.on("text_delta", event => listener({ type: "text.delta", delta: event.delta })),
        bus.on("tool_start", event => listener({ type: "tool.start", name: event.name, args: event.args })),
        bus.on("tool_end", event => listener({ type: "tool.end", name: event.name })),
      ];
      return () => unsubs.forEach(unsubscribe => unsubscribe());
    },
    async prompt(text) {
      if (active) throw new Error("A prompt is already running");
      if (typeof text !== "string" || !text.trim()) throw new TypeError("Prompt text is required");
      const controller = new AbortController();
      const turnId = randomUUID();
      active = { controller, turnId };
      const userMessage = { role: "user", content: text };
      await store.append({ type: "turn.requested", sessionId, turnId });
      await store.append({ type: "turn.started", sessionId, turnId });
      await store.append({ type: "user.message.accepted", sessionId, turnId, message: userMessage });
      messages.push(userMessage);
      bus.emit("agent", { type: "agent.start" });
      bus.emit("agent", { type: "message.start", role: "assistant" });
      try {
        await store.append({ type: "model.request.started", sessionId, turnId, model: provider.model || "custom" });
        const result = await runTurn({
          provider,
          messages,
          tools: openAiTools(registry),
          maxSteps,
          signal: controller.signal,
          bus,
          onMessage: message => store.append({ type: message.role === "assistant" ? "assistant.message.completed" : "tool.result.recorded", sessionId, turnId, message }),
          onPartial: message => store.append({ type: "assistant.message.interrupted", sessionId, turnId, status: "INTERRUPTED", content: message.content.slice(0, 20_000), contentBytes: Buffer.byteLength(message.content), truncated: message.content.length > 20_000 }),
          executeTool: async (name, args, context) => {
            const toolExecutionId = randomUUID();
            await store.append({ type: "tool.call.started", sessionId, turnId, toolCallId: context.toolCallId, toolExecutionId, name, step: context.step });
            bus.emit("tool_start", { name, args });
            try {
              const result = await receipts.execute({ toolCallId: context.toolCallId, toolName: name, args, invoke: () => registry.execute(name, args, { ...context, cwd }) });
              const output = boundedAuditValue(toolText(result), 20_000);
              await store.append({ type: "tool.call.completed", sessionId, turnId, toolCallId: context.toolCallId, toolExecutionId, name, outputBytes: Buffer.byteLength(output) });
              return output;
            } catch (error) {
              await store.append({ type: "tool.call.failed", sessionId, turnId, toolCallId: context.toolCallId, toolExecutionId, name, error: boundedAuditValue(error instanceof Error ? error.message : String(error), 4_000) });
              throw error;
            } finally { bus.emit("tool_end", { name }); }
          },
        });
        await store.append({ type: "turn.completed", sessionId, turnId, usage: result.usage });
        bus.emit("agent", { type: "message.end", role: "assistant", usage: { ...result.usage, cost: 0 } });
        return result;
      } catch (error) {
        await store.append({ type: controller.signal.aborted ? "turn.cancelled" : "turn.failed", sessionId, turnId, error: boundedAuditValue(error instanceof Error ? error.message : String(error), 4_000) });
        throw error;
      } finally {
        active = undefined;
      }
    },
    async abort() {
      if (!active) return;
      await store.append({ type: "turn.cancel.requested", sessionId, turnId: active.turnId });
      active.controller.abort(new Error("Operation aborted"));
    },
    dispose() { active?.controller.abort(new Error("Session disposed")); bus.clear(); },
  };
  return assertAgentSession(session);
}
