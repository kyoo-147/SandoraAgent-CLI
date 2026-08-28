import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EventBus, JsonlSessionStore, OpenAICompatibleProvider, runTurn } from "./turn-runtime.mjs";
import { NativeToolRegistry, openAiTools, toolText } from "../tools/registry.mjs";
import { createDelegateSubagentsTool } from "../agents/subagents.mjs";
import { assertAgentSession } from "./agent-session.mjs";

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
  const resumed = events.filter(event => event.type === "message").map(event => event.message);
  const existingSession = events.find(event => event.type === "session.started");
  const sessionId = existingSession?.sessionId || randomUUID();
  await store.append({ type: existingSession ? "session.resumed" : "session.started", sessionId, runtime: "sandora-native", model: provider.model || "custom" });
  const messages = [{ role: "system", content: systemPrompt }, ...resumed.filter(message => message?.role !== "system")];
  if (!registry.has("delegate_subagents")) registry.register(createDelegateSubagentsTool({ provider, cwd }));
  let active;
  const session = {
    runtime: "native",
    sessionId,
    thinkingLevel: undefined,
    model: { id: provider.model || "custom" },
    getContextUsage: () => ({ tokens: Math.ceil(JSON.stringify(messages).length / 4) }),
    getLastAssistantText: () => messages.findLast(message => message?.role === "assistant")?.content,
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
      await store.append({ type: "turn.started", sessionId, turnId });
      await store.appendMessage(userMessage);
      messages.push(userMessage);
      bus.emit("agent", { type: "agent.start" });
      bus.emit("agent", { type: "message.start", role: "assistant" });
      try {
        await store.append({ type: "model.started", sessionId, turnId, model: provider.model || "custom" });
        const beforeRun = messages.length;
        const result = await runTurn({
          provider,
          messages,
          tools: openAiTools(registry),
          maxSteps,
          signal: controller.signal,
          bus,
          executeTool: async (name, args, context) => {
            const toolExecutionId = randomUUID();
            await store.append({ type: "tool.started", sessionId, turnId, toolExecutionId, name, step: context.step });
            bus.emit("tool_start", { name, args });
            try {
              const output = toolText(await registry.execute(name, args, { ...context, cwd }));
              await store.append({ type: "tool.completed", sessionId, turnId, toolExecutionId, name, outputBytes: Buffer.byteLength(output) });
              return output;
            } catch (error) {
              await store.append({ type: "tool.failed", sessionId, turnId, toolExecutionId, name, error: error instanceof Error ? error.message : String(error) });
              throw error;
            } finally { bus.emit("tool_end", { name }); }
          },
        });
        for (const message of result.messages.slice(beforeRun)) await store.appendMessage(message);
        await store.append({ type: "turn.completed", sessionId, turnId, usage: result.usage });
        bus.emit("agent", { type: "message.end", role: "assistant", usage: { ...result.usage, cost: 0 } });
        return result;
      } catch (error) {
        await store.append({ type: controller.signal.aborted ? "turn.aborted" : "turn.failed", sessionId, turnId, error: error instanceof Error ? error.message : String(error) });
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
