import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createPiSubagentsTool } from "../agents/pi-subagents.mjs";
import { createPiWritableWorkerTools } from "../agents/pi-writable-workers.mjs";
import { assertAgentSession } from "./agent-session.mjs";
import { defineTool } from "../tools/registry.mjs";

export async function createPiAgentSession({
  cwd = process.cwd(),
  agentDir = join(homedir(), ".pi", "agent"),
  systemPrompt = "You are Sandora Agent.",
  customTools = [],
} = {}) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPrompt,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const workerProvider = process.env.SANDORA_WORKER_PROVIDER || "openai-codex";
  const workerModelId = process.env.SANDORA_WORKER_MODEL || "gpt-5.6-luna";
  const workerModel = modelRuntime.getModel(workerProvider, workerModelId);
  if (!workerModel) throw new Error(`Required Sandora worker model is unavailable: ${workerProvider}/${workerModelId}`);
  const delegate = createPiSubagentsTool({ cwd, agentDir, modelRuntime, model: workerModel, thinkingLevel: "medium" });
  const writableWorkers = createPiWritableWorkerTools({ cwd, agentDir, modelRuntime, model: workerModel, thinkingLevel: "medium" });
  const allCustomTools = [delegate, ...writableWorkers, ...customTools].map(defineTool);
  const names = new Set();
  for (const tool of allCustomTools) {
    if (names.has(tool.name)) throw new Error(`Duplicate Pi tool name: ${tool.name}`);
    names.add(tool.name);
  }
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader: loader,
    noTools: "builtin",
    tools: allCustomTools.map(tool => tool.name),
    customTools: allCustomTools,
    sessionManager: SessionManager.continueRecent(cwd, join(cwd, ".sandora", "pi-sessions")),
  });

  return assertAgentSession({
    runtime: "pi",
    sessionId: session.sessionId,
    thinkingLevel: session.thinkingLevel,
    model: session.model,
    getContextUsage: () => session.getContextUsage(),
    getLastAssistantText: () => session.getLastAssistantText(),
    prompt: text => session.prompt(text),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    subscribe: listener => session.subscribe(event => {
      const normalized = normalizePiEvent(event);
      if (normalized) listener(normalized);
    }),
  });
}

export function normalizePiEvent(event) {
  if (event.type === "agent_start") return { type: "agent.start" };
  if (event.type === "agent_end") return { type: "agent.end", willRetry: Boolean(event.willRetry) };
  if (event.type === "agent_settled") return { type: "agent.settled" };
  if (event.type === "turn_start") return { type: "turn.start" };
  if (event.type === "turn_end") return { type: "turn.end", toolResultCount: event.toolResults?.length || 0 };
  if (event.type === "message_start") return { type: "message.start", role: event.message?.role };
  if (event.type === "message_end") return {
    type: "message.end",
    role: event.message?.role,
    usage: {
      input: event.message?.usage?.input ?? 0,
      output: event.message?.usage?.output ?? 0,
      cacheRead: event.message?.usage?.cacheRead ?? 0,
      cacheWrite: event.message?.usage?.cacheWrite ?? 0,
      total: event.message?.usage?.totalTokens ?? event.message?.usage?.total ?? 0,
      cost: event.message?.usage?.cost?.total ?? 0,
    },
  };
  if (event.type === "tool_execution_start") return { type: "tool.start", id: event.toolCallId, name: event.toolName, args: event.args };
  if (event.type === "tool_execution_update") return { type: "tool.update", id: event.toolCallId, name: event.toolName, args: event.args, partialResult: event.partialResult };
  if (event.type === "tool_execution_end") return { type: "tool.end", id: event.toolCallId, name: event.toolName, result: event.result, isError: Boolean(event.isError) };
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") return { type: "text.delta", delta: event.assistantMessageEvent.delta };
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") return { type: "thinking.delta", delta: event.assistantMessageEvent.delta };
  if (event.type === "queue_update") return { type: "queue.update", steering: event.steering?.length || 0, followUp: event.followUp?.length || 0 };
  if (event.type === "compaction_start") return { type: "compaction.start", reason: event.reason };
  if (event.type === "compaction_end") return { type: "compaction.end", reason: event.reason, aborted: Boolean(event.aborted), willRetry: Boolean(event.willRetry), error: event.errorMessage };
  if (event.type === "auto_retry_start" || event.type === "summarization_retry_scheduled" || event.type === "summarization_retry_attempt_start") return { type: "retry.start", source: event.type };
  if (event.type === "auto_retry_end" || event.type === "summarization_retry_finished") return { type: "retry.end", source: event.type };
  if (event.type === "thinking_level_changed") return { type: "thinking.changed", level: event.level };
  if (event.type === "session_info_changed") return { type: "session.changed", name: event.name };
  if (event.type === "entry_appended") return { type: "session.entry", entryType: event.entry?.type };
  if (event.type === "bash_execution_update") return { type: "process.update" };
  return { type: "runtime.unknown", source: "pi", sourceType: typeof event?.type === "string" ? event.type : "missing", nestedType: event?.assistantMessageEvent?.type };
}
