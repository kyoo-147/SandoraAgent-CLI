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
