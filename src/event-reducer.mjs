const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cost: 0 });

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
    case "message.start":
      return event.role === "assistant" ? { ...state, status: "THINKING", activity: "Preparing an answer" } : state;
    case "message.end":
      return event.role === "assistant"
        ? { ...state, status: "COMPLETE", usage: usageWith(state, event.usage) }
        : state;
    case "tool.start":
      return { ...state, status: "RUNNING", lastTool: event.name || "", activity: `Running ${event.name || "tool"}` };
    case "tool.update":
      return { ...state, status: "RUNNING", activity: `Inspecting ${event.name || state.lastTool || "tool"} output` };
    case "tool.end":
      return { ...state, status: "THINKING", activity: `Reviewing ${event.name || state.lastTool || "tool"} result` };
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
