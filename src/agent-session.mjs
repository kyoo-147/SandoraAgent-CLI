/**
 * Sandora's runtime seam. Implementations expose this small interface and emit
 * normalized events; runtime-specific event objects stay inside adapters.
 *
 * @typedef {Object} AgentSession
 * @property {string} sessionId
 * @property {string|undefined} thinkingLevel
 * @property {Object|undefined} model
 * @property {() => Object|undefined} getContextUsage
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
