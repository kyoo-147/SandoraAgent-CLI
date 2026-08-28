import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { EventBus, JsonlSessionStore, OpenAICompatibleProvider, runTurn } from "./turn-runtime.mjs";
import { NativeToolRegistry, openAiTools, toolText } from "../tools/registry.mjs";
import { createDelegateSubagentsTool } from "../agents/subagents.mjs";
import { assertAgentSession, normalizeDisplayMessages } from "./agent-session.mjs";
import { compactContext, measureContext, validateCompactionProvenance } from "./context-budget.mjs";
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

async function repairIncompleteLifecycle(store, events) {
  const requestTerminals = new Set(events.filter(event => ["model.request.completed", "model.request.failed", "model.request.unknown"].includes(event.type)).map(event => event.payload?.requestId).filter(Boolean));
  for (const event of events.filter(event => event.type === "model.request.requested")) {
    const requestId = event.payload?.requestId;
    if (requestId && !requestTerminals.has(requestId)) { await store.append({ type: "model.request.unknown", correlationId: requestId, ...event.payload, status: "UNKNOWN_AFTER_RESTART" }); requestTerminals.add(requestId); }
  }
  for (const event of events.filter(event => event.type === "model.request.started")) {
    const requestId = event.payload?.requestId;
    if (requestId && !requestTerminals.has(requestId)) { await store.append({ type: "model.request.unknown", correlationId: requestId, ...event.payload, status: "UNKNOWN_AFTER_RESTART" }); requestTerminals.add(requestId); }
  }
  const toolTerminals = new Set(events.filter(event => ["tool.call.completed", "tool.call.failed", "tool.call.cancelled", "tool.call.unknown"].includes(event.type)).map(event => event.payload?.toolCallId).filter(Boolean));
  for (const event of events.filter(event => event.type === "tool.call.requested")) {
    const toolCallId = event.payload?.toolCallId;
    if (toolCallId && !toolTerminals.has(toolCallId)) { await store.append({ type: "tool.call.unknown", correlationId: toolCallId, ...event.payload, status: "UNKNOWN_AFTER_RESTART" }); toolTerminals.add(toolCallId); }
  }
  for (const event of events.filter(event => event.type === "tool.call.started")) {
    const toolCallId = event.payload?.toolCallId;
    if (toolCallId && !toolTerminals.has(toolCallId)) { await store.append({ type: "tool.call.unknown", correlationId: toolCallId, ...event.payload, status: "UNKNOWN_AFTER_RESTART" }); toolTerminals.add(toolCallId); }
  }
  const assistantTerminals = new Set(events.filter(event => ["assistant.message.completed", "assistant.message.interrupted"].includes(event.type)).map(event => event.payload?.assistantMessageId).filter(Boolean));
  for (const event of events.filter(event => event.type === "assistant.message.started")) {
    const assistantMessageId = event.payload?.assistantMessageId;
    if (assistantMessageId && !assistantTerminals.has(assistantMessageId)) { await store.append({ type: "assistant.message.interrupted", correlationId: assistantMessageId, sessionId: event.payload.sessionId, turnId: event.payload.turnId, requestId: event.payload.requestId, assistantMessageId, status: "UNKNOWN_AFTER_RESTART", content: "", contentBytes: 0, truncated: false }); assistantTerminals.add(assistantMessageId); }
  }
}

function withMessageId(message, messageId) { Object.defineProperty(message, "messageId", { value: messageId, enumerable: false, configurable: true }); return message; }
function hydrateHistory(events) {
  return events.filter(event => ["user.message.accepted", "assistant.message.completed", "tool.result.recorded"].includes(event.type) && event.payload?.message).map(event => withMessageId({ ...event.payload.message }, event.id));
}

function hydrateContext(events, systemPrompt) {
  const system = withMessageId({ role: "system", content: systemPrompt }, "system-prompt");
  let active = [];
  const compactionIds = new Set();
  for (const event of events) {
    if (["user.message.accepted", "assistant.message.completed", "tool.result.recorded"].includes(event.type) && event.payload?.message) active.push(withMessageId({ ...event.payload.message }, event.id));
    if (event.type === "context.compacted") {
      if (!event.payload.compactionId || compactionIds.has(event.payload.compactionId)) throw new Error("duplicate context compaction ID");
      compactionIds.add(event.payload.compactionId);
      const retained = validateCompactionProvenance(event.payload, [system, ...active]);
      if (event.payload.after?.messages !== retained.length || event.payload.before?.messages < retained.length) throw new Error("invalid context compaction counts");
      active = retained.filter(message => message.role !== "system");
    }
  }
  return active;
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
  maxContextBytes,
  contextReserveBytes = 0,
} = {}) {
  if (maxContextBytes !== undefined && (!Number.isSafeInteger(maxContextBytes) || maxContextBytes <= 0)) throw new TypeError("maxContextBytes must be a positive integer");
  if (!Number.isSafeInteger(contextReserveBytes) || contextReserveBytes < 0 || (maxContextBytes !== undefined && contextReserveBytes >= maxContextBytes)) throw new TypeError("contextReserveBytes must be a non-negative integer below maxContextBytes");
  const store = new JsonlSessionStore(sessionPath);
  const bus = new EventBus();
  const events = await store.replay();
  if (events.some(event => event.type === "session.closed")) throw new Error("Native session is closed");
  await repairIncompleteLifecycle(store, events);
  await repairIncompleteToolTranscript(store, events);
  const hydratedEvents = await store.replay();
  const existingSession = events.find(event => event.type === "session.created");
  const modelId = provider.model || "custom";
  const systemPromptSha256 = createHash("sha256").update(systemPrompt).digest("hex");
  const persistedPromptSha256 = existingSession?.payload?.systemPromptSha256;
  const persistedModel = existingSession?.payload?.model;
  const persistedContextConfig = events.findLast(event => ["session.created", "session.resumed"].includes(event.type) && event.payload?.maxContextBytes !== undefined);
  const persistedMaxContextBytes = persistedContextConfig?.payload?.maxContextBytes;
  const persistedContextReserveBytes = persistedContextConfig?.payload?.contextReserveBytes;
  if (existingSession && ((persistedPromptSha256 !== undefined && persistedPromptSha256 !== systemPromptSha256) || (persistedModel !== undefined && persistedModel !== modelId) || (persistedMaxContextBytes !== undefined && persistedMaxContextBytes !== maxContextBytes) || (persistedMaxContextBytes !== undefined && persistedContextReserveBytes !== contextReserveBytes))) throw new Error("native session identity does not match persisted session");
  const sessionId = existingSession?.payload?.sessionId || randomUUID();
  const receipts = new ToolReceiptStore({ cwd, sessionId, runtime: "native" });
  await store.append({ type: existingSession ? "session.resumed" : "session.created", sessionId, runtime: "sandora-native", model: modelId, systemPromptSha256, ...(maxContextBytes === undefined ? {} : { maxContextBytes, contextReserveBytes }) });
  const modelSystem = withMessageId({ role: "system", content: systemPrompt }, "system-prompt");
  const messages = [modelSystem, ...hydrateContext(hydratedEvents, systemPrompt)];
  const historyMessages = [withMessageId({ role: "system", content: systemPrompt }, "system-prompt"), ...hydrateHistory(hydratedEvents)];
  if (!registry.has("delegate_subagents")) registry.register(createDelegateSubagentsTool({ provider, cwd }));
  let active;
  let closed = false;
  let closePromise;
  const session = {
    runtime: "native",
    sessionId,
    thinkingLevel: undefined,
    model: { id: modelId },
    getContextUsage: () => measureContext(messages),
    getLastAssistantText: () => historyMessages.findLast(message => message?.role === "assistant")?.content,
    getDisplayMessages: () => normalizeDisplayMessages(historyMessages),
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
      if (closed) throw new Error("Session is closed");
      if (typeof text !== "string" || !text.trim()) throw new TypeError("Prompt text is required");
      const controller = new AbortController();
      const turnId = randomUUID();
      let resolveSettled;
      const settled = new Promise(resolve => { resolveSettled = resolve; });
      active = { controller, turnId, settled, resolveSettled, cancelRequested: false, terminalizing: false };
      const userMessage = { role: "user", content: text };
      await store.append({ type: "turn.requested", sessionId, turnId });
      await store.append({ type: "turn.started", sessionId, turnId });
      const userEvent = await store.append({ type: "user.message.accepted", sessionId, turnId, message: userMessage });
      withMessageId(userMessage, userEvent.id); messages.push(userMessage); historyMessages.push(userMessage);
      bus.emit("agent", { type: "agent.start" });
      bus.emit("agent", { type: "message.start", role: "assistant" });
      try {
        const result = await runTurn({
          provider,
          messages,
          tools: openAiTools(registry),
          maxSteps,
          signal: controller.signal,
          bus,
          prepareMessages: maxContextBytes === undefined ? undefined : async ({ messages: requestMessages, step, attempt }) => {
            if (measureContext(requestMessages).bytes + contextReserveBytes <= maxContextBytes) return;
            const sourceMessageIds = requestMessages.map(message => message.messageId);
            if (sourceMessageIds.some(id => typeof id !== "string")) throw new Error("context compaction requires durable message IDs");
            const compacted = compactContext(requestMessages, { maxBytes: maxContextBytes, reserveBytes: contextReserveBytes });
            if (compacted.retainedMessageIds.length > 200) throw new Error("context compaction retained provenance exceeds the bounded message-ID limit");
            await store.append({ type: "context.compacted", sessionId, turnId, compactionId: randomUUID(), algorithm: compacted.algorithm, reason: "budget", step, attempt, before: compacted.before, after: compacted.after, sourceMessageCount: sourceMessageIds.length, sourceEventRange: { first: sourceMessageIds[0], last: sourceMessageIds.at(-1) }, droppedMessageCount: compacted.droppedMessageIds.length, retainedMessageIds: compacted.retainedMessageIds, contextSha256: compacted.contextSha256 });
            requestMessages.splice(0, requestMessages.length, ...compacted.messages);
          },
          onModelRequestRequested: ({ requestId, step, attempt }) => store.append({ type: "model.request.requested", correlationId: requestId, sessionId, turnId, requestId, step, attempt, model: provider.model || "custom" }),
          onModelRequestStarted: ({ requestId, step, attempt }) => store.append({ type: "model.request.started", correlationId: requestId, sessionId, turnId, requestId, step, attempt, model: provider.model || "custom" }),
          onModelRequestCompleted: ({ requestId, step, attempt }) => store.append({ type: "model.request.completed", correlationId: requestId, sessionId, turnId, requestId, step, attempt }),
          onModelRequestFailed: ({ requestId, step, attempt, error }) => store.append({ type: "model.request.failed", correlationId: requestId, sessionId, turnId, requestId, step, attempt, error: boundedAuditValue(error instanceof Error ? error.message : String(error), 4_000) }),
          onAssistantStarted: ({ requestId, assistantMessageId, step }) => store.append({ type: "assistant.message.started", correlationId: assistantMessageId, sessionId, turnId, requestId, assistantMessageId, step }),
          onAssistantDelta: ({ requestId, assistantMessageId, delta, deltaIndex }) => store.append({ type: "assistant.delta", correlationId: assistantMessageId, sessionId, turnId, requestId, assistantMessageId, delta, deltaIndex }),
          onUsage: ({ requestId, usageId, usage }) => store.append({ type: "model.usage", correlationId: requestId, sessionId, turnId, requestId, usageId, usage: { input: usage?.prompt_tokens || 0, output: usage?.completion_tokens || 0, cacheRead: usage?.prompt_tokens_details?.cached_tokens || 0 } }),
          onToolRequested: ({ requestId, assistantMessageId, step, toolCallId, name }) => store.append({ type: "tool.call.requested", correlationId: toolCallId, sessionId, turnId, requestId, assistantMessageId, toolCallId, name, step }),
          onMessage: async (message, metadata) => { const event = await store.append({ type: message.role === "assistant" ? "assistant.message.completed" : "tool.result.recorded", correlationId: message.role === "assistant" ? metadata.assistantMessageId : metadata.toolCallId, sessionId, turnId, requestId: metadata.requestId, assistantMessageId: metadata.assistantMessageId, message }); withMessageId(message, event.id); historyMessages.push(message); },
          onPartial: (message, metadata) => { const originalBytes = Buffer.byteLength(message.content); const content = boundedAuditValue(message.content, 20_000); return store.append({ type: "assistant.message.interrupted", correlationId: metadata.assistantMessageId, sessionId, turnId, requestId: metadata.requestId, assistantMessageId: metadata.assistantMessageId, status: "INTERRUPTED", content, contentBytes: Buffer.byteLength(content), truncated: originalBytes > Buffer.byteLength(content) }); },
          executeTool: async (name, args, context) => {
            const toolExecutionId = randomUUID();
            await store.append({ type: "tool.call.started", correlationId: context.toolCallId, sessionId, turnId, toolCallId: context.toolCallId, toolExecutionId, name, step: context.step });
            bus.emit("tool_start", { name, args });
            try {
              const result = await receipts.execute({ toolCallId: context.toolCallId, toolName: name, args, invoke: () => registry.execute(name, args, { ...context, cwd }) });
              const output = boundedAuditValue(toolText(result), 20_000);
              await store.append({ type: "tool.call.completed", correlationId: context.toolCallId, sessionId, turnId, toolCallId: context.toolCallId, toolExecutionId, name, outputBytes: Buffer.byteLength(output) });
              return output;
            } catch (error) {
              await store.append({ type: context.signal?.aborted ? "tool.call.cancelled" : "tool.call.failed", correlationId: context.toolCallId, sessionId, turnId, toolCallId: context.toolCallId, toolExecutionId, name, error: boundedAuditValue(error instanceof Error ? error.message : String(error), 4_000) });
              throw error;
            } finally { bus.emit("tool_end", { name }); }
          },
        });
        active.terminalizing = true;
        await store.append({ type: "turn.completed", sessionId, turnId, usage: result.usage });
        bus.emit("agent", { type: "message.end", role: "assistant", usage: { ...result.usage, cost: 0 } });
        return result;
      } catch (error) {
        active.terminalizing = true;
        await store.append({ type: controller.signal.aborted ? "turn.cancelled" : "turn.failed", sessionId, turnId, error: boundedAuditValue(error instanceof Error ? error.message : String(error), 4_000) });
        throw error;
      } finally {
        active?.resolveSettled();
        active = undefined;
      }
    },
    async abort() {
      if (!active || active.terminalizing) return;
      if (!active.cancelRequested) { await store.append({ type: "turn.cancel.requested", sessionId, turnId: active.turnId }); active.cancelRequested = true; }
      active.controller.abort(new Error("Operation aborted"));
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        const running = active;
        if (running && !running.terminalizing) {
          if (!running.cancelRequested) { await store.append({ type: "turn.cancel.requested", sessionId, turnId: running.turnId }); running.cancelRequested = true; }
          running.controller.abort(new Error("Session closed"));
        }
        if (running) await running.settled;
        await store.append({ type: "session.closed", sessionId, reason: "intentional" });
        bus.clear();
      })();
      return closePromise;
    },
    dispose() { active?.controller.abort(new Error("Session disposed")); bus.clear(); },
  };
  return assertAgentSession(session);
}
