import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class EventBus {
  #listeners = new Map();
  on(type, listener) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(listener);
    return () => this.#listeners.get(type)?.delete(listener);
  }
  emit(type, event = {}) {
    for (const listener of this.#listeners.get(type) || []) listener({ type, ...event });
  }
  clear() { this.#listeners.clear(); }
}

export function assertProvider(provider) {
  if (!provider || typeof provider.stream !== "function") throw new TypeError("Provider must expose stream(request, signal)");
  return provider;
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
        if (!row.startsWith("data:")) continue;
        const value = row.slice(5).trim();
        if (value === "[DONE]") return;
        let payload;
        try { payload = JSON.parse(value); } catch { continue; }
        if (payload.usage) yield { type: "usage", usage: payload.usage };
        const choice = payload.choices?.[0];
        const delta = choice?.delta || {};
        if (delta.content) yield { type: "text_delta", delta: delta.content };
        for (const call of delta.tool_calls || []) yield { type: "tool_call_delta", index: call.index || 0, id: call.id, name: call.function?.name, arguments: call.function?.arguments || "" };
        if (choice?.finish_reason) yield { type: "finish", reason: choice.finish_reason, usage: payload.usage };
      }
    }
  }
}

function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason || new Error("Operation aborted"); }
function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

export async function runTurn({ provider, messages = [], tools = [], executeTool, maxSteps = 8, maxRetries = 2, signal, bus = new EventBus(), retryDelayMs = 0 } = {}) {
  assertProvider(provider);
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array");
  const usage = { input: 0, output: 0, cacheRead: 0 };
  for (let step = 0; step < maxSteps; step++) {
    throwIfAborted(signal);
    let text, calls, lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      text = []; calls = new Map();
      let receivedDelta = false;
      try {
        for await (const event of provider.stream({ messages, tools, signal })) {
          throwIfAborted(signal);
          if (event.type === "usage") {
            usage.input += event.usage?.prompt_tokens || 0;
            usage.output += event.usage?.completion_tokens || 0;
            usage.cacheRead += event.usage?.prompt_tokens_details?.cached_tokens || 0;
            bus.emit("usage", { usage: { ...usage } });
          }
          else if (event.type === "text_delta") { receivedDelta = true; text.push(event.delta); bus.emit("text_delta", event); }
          else if (event.type === "tool_call_delta") {
            receivedDelta = true;
            const current = calls.get(event.index) || { id: event.id, name: event.name, arguments: "" };
            if (event.id) current.id = event.id;
            if (event.name) current.name = event.name;
            current.arguments += event.arguments || "";
            calls.set(event.index, current);
            bus.emit("tool_call_delta", event);
          }
        }
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (receivedDelta) break;
        if (attempt < maxRetries) { if (retryDelayMs) await sleep(retryDelayMs); }
      }
    }
    if (lastError) throw lastError;
    const assistant = { role: "assistant", content: text.join("") || null };
    if (calls.size) assistant.tool_calls = [...calls.values()].map((call) => {
      if (!call.id || !call.name) throw new Error("Provider returned an incomplete tool call");
      return { id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } };
    });
    messages.push(assistant);
    bus.emit("assistant", { message: assistant, step });
    if (!calls.size) return { messages, message: assistant, steps: step + 1, usage, bus };
    if (typeof executeTool !== "function") throw new Error("Tool calls require executeTool");
    for (const call of calls.values()) {
      throwIfAborted(signal);
      let args;
      try { args = JSON.parse(call.arguments || "{}"); } catch { throw new Error(`Invalid arguments for tool ${call.name}`); }
      const result = await executeTool(call.name, args, { signal, step });
      const content = typeof result === "string" ? result : JSON.stringify(result);
      messages.push({ role: "tool", tool_call_id: call.id, content });
      bus.emit("tool_result", { call, content, step });
    }
    if (step === maxSteps - 1) throw new Error(`Maximum turn steps exceeded (${maxSteps})`);
  }
  throw new Error(`Maximum turn steps exceeded (${maxSteps})`);
}

export class JsonlSessionStore {
  #sequence;
  #tail = Promise.resolve();
  constructor(filePath) { this.filePath = resolve(filePath); }
  async append(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event must be an object");
    const pending = this.#tail.then(async () => {
      if (this.#sequence === undefined) {
        const existing = await this.replay();
        this.#sequence = existing.reduce((max, item) => Math.max(max, Number.isInteger(item.sequence) ? item.sequence : 0), 0);
      }
      await mkdir(dirname(this.filePath), { recursive: true });
      const envelope = { schemaVersion: 1, ...event, sequence: ++this.#sequence, timestamp: event.timestamp || new Date().toISOString() };
      await appendFile(this.filePath, `${JSON.stringify(envelope)}\n`, "utf8");
      return envelope;
    });
    this.#tail = pending.catch(() => {});
    return pending;
  }
  async replay() {
    let text;
    try { text = await readFile(this.filePath, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const terminated = /\r?\n$/.test(text);
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.flatMap((line, index) => {
      try { return [JSON.parse(line)]; }
      catch {
        if (!terminated && index === lines.length - 1) return [];
        throw new Error(`Invalid JSONL at line ${index + 1}`);
      }
    });
  }
  async resume() { return (await this.replay()).filter((event) => event.type === "message").map((event) => event.message); }
  async appendMessage(message) { await this.append({ type: "message", message }); }
}
