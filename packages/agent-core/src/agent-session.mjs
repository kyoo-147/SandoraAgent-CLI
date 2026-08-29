/**
 * Sandora's runtime seam. Implementations expose this small interface and emit
 * normalized events; runtime-specific event objects stay inside adapters.
 *
 * @typedef {Object} AgentSession
 * @property {string|undefined} runtime
 * @property {string} sessionId
 * @property {string|undefined} thinkingLevel
 * @property {Object|undefined} model
 * @property {() => Object|undefined} getContextUsage
 * @property {() => string|undefined} getLastAssistantText
 * @property {() => Array<{role: "user"|"assistant", text: string}>} getDisplayMessages
 * @property {(text: string) => Promise<unknown>} prompt
 * @property {() => Promise<unknown>} abort
 * @property {() => void} dispose
 * @property {(listener: (event: object) => void) => (() => void)|void} subscribe
 */

export function assertAgentSession(session) {
  for (const method of ["prompt", "abort", "dispose", "subscribe"]) {
    if (typeof session?.[method] !== "function") throw new TypeError(`AgentSession.${method} is required`);
  }
  return session;
}

/** Add one runtime-independent run lifecycle around a core-specific session. */
export function withRunLifecycle(session) {
  assertAgentSession(session);
  const listeners = new Set();
  let active = null;
  const emit = event => { for (const listener of [...listeners]) listener(event); };
  const unsubscribeSource = session.subscribe(event => emit(event));
  return assertAgentSession({
    ...session,
    prompt: async text => {
      if (active) throw new Error("An agent prompt is already active");
      const run = { abortRequested: false };
      active = run;
      emit({ type: "run.start" });
      try {
        const result = await session.prompt(text);
        emit({ type: run.abortRequested ? "run.abort" : "run.complete" });
        return result;
      } catch (error) {
        emit(run.abortRequested ? { type: "run.abort" } : { type: "run.error", error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally { if (active === run) active = null; }
    },
    abort: async () => { if (active) active.abortRequested = true; return session.abort(); },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    dispose: () => { unsubscribeSource?.(); listeners.clear(); return session.dispose(); },
  });
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0, high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle; else high = middle - 1;
  }
  return value.slice(0, low);
}
function displayText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("");
}

/** Project runtime messages into a renderer-safe, tool-free conversation view. */
export function normalizeDisplayMessages(messages, { maxMessages = 200, maxTextBytes = 20_000 } = {}) {
  if (!Array.isArray(messages)) return [];
  return messages.filter(message => message?.role === "user" || message?.role === "assistant").map(message => ({ role: message.role, text: truncateUtf8(displayText(message.content), maxTextBytes) })).filter(message => message.text).slice(-maxMessages);
}
