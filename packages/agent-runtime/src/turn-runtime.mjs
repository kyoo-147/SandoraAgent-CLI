import { randomUUID } from "node:crypto";

export class EventBus {
  #listeners = new Map();
  on(type, listener) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(listener);
    return () => this.#listeners.get(type)?.delete(listener);
  }
  emit(type, event = {}) {
    const payload = { type, ...event };
    for (const listener of [...(this.#listeners.get(type) || [])]) {
      try { listener(payload); }
      catch (error) {
        if (type === "listener_error") continue;
        const diagnostic = { type: "listener_error", sourceType: type, error: String(error instanceof Error ? error.message : error).slice(0, 1_000) };
        for (const observer of [...(this.#listeners.get("listener_error") || [])]) try { observer(diagnostic); } catch { /* listener diagnostics are isolated too */ }
      }
    }
  }
  clear() { this.#listeners.clear(); }
}

export function assertProvider(provider) {
  if (!provider || typeof provider.stream !== "function") throw new TypeError("Provider must expose stream(request, signal)");
  return provider;
}

function takeUtf8Prefix(value, maxBytes) {
  let end = 0; let bytes = 0;
  for (const character of value) { const size = Buffer.byteLength(character); if (bytes + size > maxBytes) break; bytes += size; end += character.length; }
  return [value.slice(0, end), value.slice(end)];
}
function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason || new Error("Operation aborted"); }
function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

export async function runTurn({ provider, messages = [], tools = [], executeTool, onMessage, onPartial, prepareMessages, onModelRequestRequested, onModelRequestStarted, onAssistantStarted, onAssistantDelta, onUsage, onToolRequested, onModelRequestCompleted, onModelRequestFailed, maxSteps = 8, maxRetries = 2, signal, bus = new EventBus(), retryDelayMs = 0 } = {}) {
  assertProvider(provider);
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array");
  const usage = { input: 0, output: 0, cacheRead: 0 };
  for (let step = 0; step < maxSteps; step++) {
    throwIfAborted(signal);
    const seenUsage = new Set();
    let text, calls, lastError;
    let activeRequestId;
    let activeAssistantMessageId;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      throwIfAborted(signal);
      await prepareMessages?.({ messages, step, attempt });
      throwIfAborted(signal);
      text = []; calls = new Map();
      let receivedDelta = false;
      const requestId = randomUUID();
      activeRequestId = requestId;
      await onModelRequestRequested?.({ requestId, step, attempt });
      await onModelRequestStarted?.({ requestId, step, attempt });
      let assistantMessageId;
      let deltaIndex = 0;
      let assistantStarted = false;
      let pendingDelta = "";
      const startAssistant = async () => { if (assistantStarted) return; assistantStarted = true; assistantMessageId ??= randomUUID(); activeAssistantMessageId = assistantMessageId; await onAssistantStarted?.({ requestId, assistantMessageId, step, attempt }); };
      const flushDelta = async force => {
        while (pendingDelta && (force || Buffer.byteLength(pendingDelta) >= 4096)) {
          const [chunk, rest] = takeUtf8Prefix(pendingDelta, 4096);
          if (!chunk) break;
          pendingDelta = rest;
          await onAssistantDelta?.({ requestId, assistantMessageId, delta: chunk, deltaIndex: deltaIndex++ });
          if (!force && Buffer.byteLength(pendingDelta) < 4096) break;
        }
      };
      try {
        for await (const event of provider.stream({ messages, tools, signal })) {
          throwIfAborted(signal);
          if (event.type === "usage") {
            const usageKey = JSON.stringify(event.usage || {});
            if (!seenUsage.has(`${requestId}:${usageKey}`)) {
              seenUsage.add(`${requestId}:${usageKey}`);
              usage.input += event.usage?.prompt_tokens || 0;
              usage.output += event.usage?.completion_tokens || 0;
              usage.cacheRead += event.usage?.prompt_tokens_details?.cached_tokens || 0;
              bus.emit("usage", { usage: { ...usage } });
              await onUsage?.({ requestId, step, attempt, usage: event.usage, usageId: randomUUID() });
            }
          }
          else if (event.type === "text_delta") { receivedDelta = true; await startAssistant(); text.push(event.delta); pendingDelta += String(event.delta); await flushDelta(false); bus.emit("text_delta", event); }
          else if (event.type === "tool_call_delta") {
            receivedDelta = true;
            await startAssistant();
            const current = calls.get(event.index) || { id: event.id, name: event.name, arguments: "" };
            if (event.id) current.id = event.id;
            if (event.name) current.name = event.name;
            current.arguments += event.arguments || "";
            calls.set(event.index, current);
            bus.emit("tool_call_delta", event);
          }
        }
        await startAssistant();
        await flushDelta(true);
        for (const call of calls.values()) { if (!call.id || !call.name) throw new Error("Provider returned an incomplete tool call"); try { JSON.parse(call.arguments || "{}"); } catch { throw new Error(`Invalid arguments for tool ${call.name}`); } }
        lastError = undefined;
        await onModelRequestCompleted?.({ requestId, step, attempt });
        break;
      } catch (error) {
        lastError = error;
        await flushDelta(true);
        await onModelRequestFailed?.({ requestId, step, attempt, error });
        if (signal?.aborted) break;
        if (receivedDelta) break;
        if (attempt < maxRetries) { if (retryDelayMs) await sleep(retryDelayMs); }
      }
    }
    if (lastError) {
      const partialText = text.join("");
      if (partialText && onPartial) await onPartial({ role: "assistant", content: partialText, status: "INTERRUPTED" }, { requestId: activeRequestId, assistantMessageId: activeAssistantMessageId, step });
      throw lastError;
    }
    const assistant = { role: "assistant", content: text.join("") || null };
    if (calls.size) assistant.tool_calls = [...calls.values()].map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }));
    messages.push(assistant);
    if (onMessage) await onMessage(assistant, { requestId: activeRequestId, assistantMessageId: activeAssistantMessageId, step });
    bus.emit("assistant", { message: assistant, step });
    if (calls.size && onToolRequested) for (const call of calls.values()) {
      let args;
      try { args = JSON.parse(call.arguments || "{}"); } catch { throw new Error(`Invalid arguments for tool ${call.name}`); }
      await onToolRequested({ requestId: activeRequestId, assistantMessageId: activeAssistantMessageId, step, toolCallId: call.id, name: call.name, args });
    }
    if (!calls.size) return { messages, message: assistant, steps: step + 1, usage, bus };
    if (typeof executeTool !== "function") throw new Error("Tool calls require executeTool");
    for (const call of calls.values()) {
      throwIfAborted(signal);
      let args;
      try { args = JSON.parse(call.arguments || "{}"); } catch { throw new Error(`Invalid arguments for tool ${call.name}`); }
      const result = await executeTool(call.name, args, { signal, step, toolCallId: call.id });
      const content = typeof result === "string" ? result : JSON.stringify(result);
      const toolMessage = { role: "tool", tool_call_id: call.id, content };
      messages.push(toolMessage);
      if (onMessage) await onMessage(toolMessage, { requestId: activeRequestId, assistantMessageId: activeAssistantMessageId, step, toolCallId: call.id });
      bus.emit("tool_result", { call, content, step });
    }
    if (step === maxSteps - 1) throw new Error(`Maximum turn steps exceeded (${maxSteps})`);
  }
  throw new Error(`Maximum turn steps exceeded (${maxSteps})`);
}
