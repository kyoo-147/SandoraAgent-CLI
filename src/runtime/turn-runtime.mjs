import { mkdir, readFile, rename, writeFile, open, unlink, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createEvent, EVENT_TYPES, isCanonicalEvent, normalizeEvent, sanitizeEventPayload, validateEvent } from "./events.mjs";
import { dirname, resolve } from "node:path";

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

function parseSseRow(row) {
  if (!row.startsWith("data:")) return { done: false, events: [] };
  const value = row.slice(5).trim();
  if (value === "[DONE]") return { done: true, events: [] };
  let payload;
  try { payload = JSON.parse(value); } catch { return { done: false, events: [] }; }
  const events = [];
  if (payload.usage) events.push({ type: "usage", usage: payload.usage });
  const choice = payload.choices?.[0];
  const delta = choice?.delta || {};
  if (delta.content) events.push({ type: "text_delta", delta: delta.content });
  for (const call of delta.tool_calls || []) events.push({ type: "tool_call_delta", index: call.index || 0, id: call.id, name: call.function?.name, arguments: call.function?.arguments || "" });
  if (choice?.finish_reason) events.push({ type: "finish", reason: choice.finish_reason, usage: payload.usage });
  return { done: false, events };
}

export class OpenAICompatibleProvider {
  constructor({ apiKey, baseUrl = "https://api.openai.com/v1", model, fetchImpl = globalThis.fetch, headers = {}, includeUsage = true } = {}) {
    if (!model) throw new TypeError("model is required");
    if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.fetch = fetchImpl;
    this.headers = headers;
    this.includeUsage = includeUsage;
  }
  async *stream({ messages, tools = [], temperature, signal } = {}) {
    const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...this.headers },
      body: JSON.stringify({ model: this.model, messages, ...(tools.length ? { tools } : {}), ...(temperature == null ? {} : { temperature }), stream: true, ...(this.includeUsage ? { stream_options: { include_usage: true } } : {}) }),
      signal,
    });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 1_000); } catch {}
      throw new Error(`Provider request failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    if (!response.body) throw new Error("Provider response has no body");
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const rows = buffer.split(/\r?\n/);
      buffer = rows.pop() || "";
      for (const row of rows) {
        const parsed = parseSseRow(row);
        if (parsed.done) return;
        for (const event of parsed.events) yield event;
      }
    }
    buffer += decoder.decode();
    for (const row of buffer.split(/\r?\n/)) {
      const parsed = parseSseRow(row);
      if (parsed.done) return;
      for (const event of parsed.events) yield event;
    }
  }
}

function takeUtf8Prefix(value, maxBytes) {
  let end = 0; let bytes = 0;
  for (const character of value) { const size = Buffer.byteLength(character); if (bytes + size > maxBytes) break; bytes += size; end += character.length; }
  return [value.slice(0, end), value.slice(end)];
}
function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason || new Error("Operation aborted"); }
function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

export async function runTurn({ provider, messages = [], tools = [], executeTool, onMessage, onPartial, onModelRequestRequested, onModelRequestStarted, onAssistantStarted, onAssistantDelta, onUsage, onToolRequested, onModelRequestCompleted, onModelRequestFailed, maxSteps = 8, maxRetries = 2, signal, bus = new EventBus(), retryDelayMs = 0 } = {}) {
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

export class JsonlSessionStore {
  #sequence;
  #tail = Promise.resolve();
  #ids = new Set();
  #streamId;
  constructor(filePath, { streamId } = {}) { this.filePath = resolve(filePath); this.#streamId = streamId || `stream-${Buffer.from(this.filePath).toString("base64url").slice(0, 40)}`; this.lastRecovery = null; }
  async #lock() {
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + 2_000;
    while (true) {
      try { return await open(lockPath, "wx"); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        let age;
        try { age = Date.now() - (await stat(lockPath)).mtimeMs; } catch { age = 0; }
        if (age > 30_000) throw new Error("stale session append lock; refusing to break it");
        if (Date.now() >= deadline) throw new Error("session append lock is busy; refusing concurrent write");
        await new Promise(resolveSleep => setTimeout(resolveSleep, 10));
      }
    }
  }
  async #repairCrashTail() {
    let bytes;
    try { bytes = await readFile(this.filePath); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!bytes.length || bytes.at(-1) === 0x0a) return;
    const lastNewline = bytes.lastIndexOf(0x0a);
    const tail = bytes.subarray(lastNewline + 1);
    let complete = false;
    try { JSON.parse(tail.toString("utf8")); complete = true; } catch { /* preserve malformed crash tail separately */ }
    const replacement = complete ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes.subarray(0, lastNewline + 1);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.repair.tmp`;
    let quarantinePath = null;
    if (!complete) {
      quarantinePath = `${this.filePath}.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID()}.crash-tail`;
      await writeFile(quarantinePath, tail, { flag: "wx" });
    }
    await writeFile(temporary, replacement, { flag: "wx" });
    await rename(temporary, this.filePath);
    this.lastRecovery = { type: complete ? "terminated-complete-tail" : "quarantined-malformed-tail", bytes: tail.length, quarantinePath };
  }
  async append(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event must be an object");
    const pending = this.#tail.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const lock = await this.#lock();
      try {
        await this.#repairCrashTail();
        const existing = await this.replay();
        this.#sequence = existing.reduce((max, item) => Math.max(max, item.sequence), 0);
        this.#ids = new Set(existing.map(item => item.id));
        const nextSequence = this.#sequence + 1;
        if (isCanonicalEvent(event)) { validateEvent(event, { expectedStreamId: this.#streamId, previousSequence: this.#sequence, ids: this.#ids }); if (event.sequence !== nextSequence) throw new Error("canonical event sequence does not match next stream sequence"); }
        const rawPayload = event.payload ?? Object.fromEntries(Object.entries(event).filter(([key]) => !["protocol", "schema", "schemaVersion", "id", "streamId", "sequence", "timestamp", "actor", "payload", "type", "correlationId", "causationId"].includes(key)));
        const normalized = EVENT_TYPES.has(event.type)
          ? { type: event.type, payload: sanitizeEventPayload(event.type, rawPayload) }
          : normalizeEvent({ ...event, payload: rawPayload, sequence: nextSequence }, { streamId: this.#streamId, sequence: nextSequence, index: nextSequence - 1 });
        const envelope = createEvent(normalized.type, normalized.payload, { id: event.id || randomUUID(), streamId: this.#streamId, sequence: nextSequence, actor: event.actor && typeof event.actor === "object" ? event.actor : { kind: "runtime", id: "sandora-native" }, timestamp: event.timestamp || new Date().toISOString(), correlationId: event.correlationId || rawPayload.turnId, causationId: event.causationId });
        validateEvent(envelope, { expectedStreamId: this.#streamId, previousSequence: this.#sequence, ids: this.#ids });
        const output = await open(this.filePath, "a");
        try { await output.writeFile(`${JSON.stringify(envelope)}\n`, "utf8"); await output.sync(); }
        finally { await output.close(); }
        this.#sequence = nextSequence; this.#ids.add(envelope.id); return envelope;
      } finally { await lock.close(); await unlink(`${this.filePath}.lock`).catch(() => {}); }
    });
    this.#tail = pending.catch(() => {});
    return pending;
  }
  async replay() {
    let text;
    try { text = await readFile(this.filePath, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const terminated = /\r?\n$/.test(text);
    const lines = text.split(/\r?\n/).filter(Boolean);
    const events = [];
    const ids = new Set();
    let previousSequence = 0;
    let replayStreamId;
    for (const [index, line] of lines.entries()) {
      try {
        const event = normalizeEvent(JSON.parse(line), { streamId: this.#streamId, sequence: index + 1, index });
        validateEvent(event, { previousSequence, ids });
        replayStreamId ??= event.streamId;
        if (event.streamId !== replayStreamId || event.streamId !== this.#streamId) throw new Error("session event stream isolation violation");
        previousSequence = event.sequence;
        ids.add(event.id);
        events.push(event);
      } catch (error) {
        if (!terminated && index === lines.length - 1 && error instanceof SyntaxError) return events;
        if (error instanceof SyntaxError) throw new Error(`Invalid JSONL at line ${index + 1}`);
        throw error;
      }
    }
    return events;
  }
  async resume() { return (await this.replay()).filter(event => ["user.message.accepted", "assistant.message.completed", "tool.result.recorded"].includes(event.type)).map(event => event.payload.message).filter(Boolean); }
  async appendMessage(message) { await this.append({ type: "message", message }); }
}
