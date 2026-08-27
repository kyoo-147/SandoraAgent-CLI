import { randomUUID } from "node:crypto";
import { SandoraAgentManager, stableId } from "./agent-manager.mjs";
import { EventBus, runTurn } from "./runtime.mjs";
import { defineTool, NativeToolRegistry, openAiTools, toolText } from "./tool-registry.mjs";
import registerWorkerTools from "./worker-tools.mjs";

export { SandoraAgentManager, createAgentManager, stableId } from "./agent-manager.mjs";

const MAX_WORKERS = 4;
const WORKER_TIMEOUT_MS = 120_000;
const parameters = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
      maxItems: MAX_WORKERS,
      description: "Independent read-only worker tasks",
    },
  },
  required: ["tasks"],
};

function validateTasks(params) {
  const tasks = params?.tasks;
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > MAX_WORKERS || tasks.some(task => typeof task !== "string" || !task.trim())) {
    throw new Error(`tasks must contain between 1 and ${MAX_WORKERS} non-empty strings`);
  }
  return tasks;
}

const description = "Run up to four independent read-only tasks in isolated native Sandora contexts. Workers can only read, search, and list files inside the workspace; they cannot access paths outside the workspace, edit files, run processes, commit, push, or deploy.";

/** A fail-closed contract used when no provider-backed native worker runner is installed. */
export const delegateSubagentsTool = defineTool({
  name: "delegate_subagents",
  label: "Delegate subagents",
  executionMode: "sequential",
  description,
  parameters,
  execute: async (_id, params) => {
    validateTasks(params);
    throw new Error("Native subagent execution is not configured for this session");
  },
});

/** Create a real bounded native worker tool sharing only the provider transport. */
export function createDelegateSubagentsTool({ provider, cwd, maxConcurrency = MAX_WORKERS } = {}) {
  if (!provider || typeof provider.stream !== "function") throw new TypeError("A provider is required for native delegation");
  const workerRegistry = registerWorkerTools(new NativeToolRegistry());
  const manager = new SandoraAgentManager({
    id: "native-delegation",
    maxConcurrency: Math.min(MAX_WORKERS, maxConcurrency),
    runner: async (task, execution) => {
      const messages = [
        { role: "system", content: "You are a bounded read-only Sandora worker. Use only the provided workspace observation tools. Return a concise evidence-backed report; never claim edits or process execution." },
        { role: "user", content: task },
      ];
      const result = await runTurn({
        provider,
        messages,
        tools: openAiTools(workerRegistry),
        executeTool: (name, args, context) => workerRegistry.execute(name, args, { ...context, cwd }),
        signal: execution.signal,
        bus: new EventBus(),
        maxSteps: 6,
      });
      return { result: result.message.content || "(worker returned no text)" };
    },
  });

  return defineTool({
    name: "delegate_subagents",
    label: "Delegate subagents",
    executionMode: "sequential",
    description,
    parameters,
    execute: async (_id, params, signal) => {
      const tasks = validateTasks(params);
      const runId = stableId("delegate", randomUUID());
      const pending = manager.start(tasks.map((prompt, index) => ({ id: `worker-${index + 1}`, prompt, budget: { wallTimeMs: WORKER_TIMEOUT_MS } })), { runId });
      const abort = () => manager.cancel(runId);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      try {
        const status = await pending;
        const output = status.tasks.map((task, index) => {
          const body = task.status === "completed" ? toolText(task.result) : `${task.status}: ${task.error || "no result"}`;
          return `WORKER ${index + 1} · ${task.status}\n${body}`;
        }).join("\n\n");
        return { content: [{ type: "text", text: output }], details: { workerCount: tasks.length, runId, native: true } };
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  });
}
