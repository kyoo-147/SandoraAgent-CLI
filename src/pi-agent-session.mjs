import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { assertAgentSession } from "./agent-session.mjs";

/** Transitional Pi adapter. The rest of the TUI consumes only AgentSession events. */
export async function createPiAgentSession({ cwd, agentDir, systemPrompt, tools, customTools }) {
  const loader = new DefaultResourceLoader({ cwd, agentDir, systemPromptOverride: () => systemPrompt });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create();
  const { session } = await createAgentSession({
    cwd, modelRuntime, resourceLoader: loader, tools, customTools,
    sessionManager: SessionManager.create(cwd),
  });
  return assertAgentSession({
    sessionId: session.sessionId,
    thinkingLevel: session.thinkingLevel,
    model: session.model,
    getContextUsage: () => session.getContextUsage(),
    prompt: (text) => session.prompt(text),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    subscribe: (listener) => session.subscribe((event) => listener(normalizePiEvent(event))),
  });
}

function normalizePiEvent(event) {
  if (event.type === "agent_start") return { type: "agent.start" };
  if (event.type === "message_start") return { type: "message.start", role: event.message?.role };
  if (event.type === "message_end") return { type: "message.end", role: event.message?.role, usage: {
    input: event.message?.usage?.input || 0,
    output: event.message?.usage?.output || 0,
    cacheRead: event.message?.usage?.cacheRead || 0,
    cost: event.message?.usage?.cost?.total || 0,
  } };
  if (event.type === "tool_execution_start") return { type: "tool.start", name: event.toolName };
  if (event.type === "tool_execution_update") return { type: "tool.update", name: event.toolName };
  if (event.type === "tool_execution_end") return { type: "tool.end", name: event.toolName };
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    return { type: "text.delta", delta: event.assistantMessageEvent.delta };
  }
  return { type: "unknown" };
}
