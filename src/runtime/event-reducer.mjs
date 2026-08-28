const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cost: 0 });
function toolStatus(name = "", args = {}) {
  if (/workspace_(read|list)/.test(name)) return "READING";
  if (/workspace_search/.test(name)) return "SEARCHING";
  if (/workspace_(write|edit|delete)/.test(name)) return "EDITING";
  if (/delegate_(subagents|writable_worker)|worker_(inspect|integrate|cleanup)/.test(name)) return "SUBAGENTS";
  if (/git_commit/.test(name)) return "COMMITTING";
  if (/git_push|github_pr_create/.test(name)) return "PUSHING";
  if (/git_|github_pr_/.test(name)) return "GIT";
  if (/browser_/.test(name)) return "BROWSER";
  if (/workspace_shell/.test(name) && /(^|\s)(test|check|build|lint|typecheck)(\s|$)|\b(npm|pnpm|yarn|node|cargo|go|pytest|vitest|jest)\b[^\r\n]*(test|check|build|lint)/i.test(args?.command || "")) return "TESTING";
  return "RUNNING";
}

export function createInitialState() {
  return {
    messages: [],
    input: "",
    cursor: 0,
    streaming: false,
    status: "READY",
    error: "",
    usage: emptyUsage(),
    responseStartedAt: 0,
    commandIndex: 0,
    activity: "",
    spinnerIndex: 0,
    lastTool: "",
    abortRequested: false,
  };
}

function usageWith(state, usage = {}) {
  return {
    input: state.usage.input + (usage.input || 0),
    output: state.usage.output + (usage.output || 0),
    cacheRead: state.usage.cacheRead + (usage.cacheRead || 0),
    cost: state.usage.cost + (usage.cost || 0),
  };
}

function ensureAssistant(state) {
  const last = state.messages.at(-1);
  if (last?.role === "assistant") return state;
  return { ...state, messages: [...state.messages, { role: "assistant", text: "" }] };
}

/** Pure reducer for the renderer-facing, Pi-independent event vocabulary. */
export function reduceAgentEvent(state, event) {
  if (!event || typeof event.type !== "string") return state;
  switch (event.type) {
    case "agent.start":
      return { ...state, status: "THINKING", activity: "Reasoning about your question", error: "" };
    case "agent.end":
      return event.willRetry ? { ...state, status: "THINKING", activity: "Retrying the model request" } : state;
    case "retry.start":
      return { ...state, status: "THINKING", activity: "Recovering from a transient model failure" };
    case "compaction.start":
      return { ...state, status: "THINKING", activity: "Compacting session context" };
    case "compaction.end":
      return event.error ? { ...state, activity: "Context compaction failed; reviewing recovery" } : { ...state, activity: "Session context compacted" };
    case "message.start":
      return event.role === "assistant" ? { ...state, status: "THINKING", activity: "Preparing an answer" } : state;
    case "message.end":
      return event.role === "assistant"
        ? { ...state, status: "COMPLETE", usage: usageWith(state, event.usage) }
        : state;
    case "tool.start":
      return { ...state, status: toolStatus(event.name, event.args), lastTool: event.name || "", activity: `Running ${event.name || "tool"}` };
    case "tool.update":
      return { ...state, status: toolStatus(event.name || state.lastTool, event.args), activity: `Inspecting ${event.name || state.lastTool || "tool"} output` };
    case "tool.end":
      return { ...state, status: "THINKING", activity: event.isError ? `Diagnosing ${event.name || state.lastTool || "tool"} failure` : `Reviewing ${event.name || state.lastTool || "tool"} result` };
    case "text.delta": {
      const next = ensureAssistant(state);
      const messages = next.messages.slice();
      messages[messages.length - 1] = { ...messages.at(-1), text: `${messages.at(-1).text}${event.delta || ""}` };
      return { ...next, messages, status: "TYPING", activity: "Writing response", responseStartedAt: next.responseStartedAt || (event.now || Date.now()) };
    }
    case "run.error":
      return { ...state, error: event.error || "Unknown session error", status: "READY", streaming: false, abortRequested: false, activity: "" };
    case "run.abort": {
      const messages = state.messages.at(-1)?.role === "assistant" && !state.messages.at(-1).text
        ? state.messages.slice(0, -1) : state.messages;
      return { ...state, messages, status: "READY", streaming: false, abortRequested: false, activity: "" };
    }
    case "run.complete":
      return { ...state, status: "READY", streaming: false, abortRequested: false, activity: "" };
    default:
      return state;
  }
}

export function cleanupOutput(state) {
  const messages = state.messages.at(-1)?.role === "assistant" && !state.messages.at(-1).text
    ? state.messages.slice(0, -1) : state.messages;
  return { ...state, messages };
}
