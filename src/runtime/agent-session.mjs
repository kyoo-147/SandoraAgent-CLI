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
