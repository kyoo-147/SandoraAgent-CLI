import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { SandoraAgentManager, stableId } from "./manager.mjs";
import { defineTool } from "../tools/registry.mjs";
import { createCodingTools } from "../tools/coding-tools.mjs";

const MAX_WORKERS = 4;
const WORKER_TIMEOUT_MS = 120_000;

export function createPiSubagentsTool({ cwd, agentDir, modelRuntime, model, thinkingLevel } = {}) {
  const manager = new SandoraAgentManager({
    id: "pi-subagents",
    maxConcurrency: MAX_WORKERS,
    runStoreRoot: join(cwd, ".sandora", "tasks", "runs"),
    leaseRoot: join(cwd, ".sandora", "tasks", "leases"),
    runner: async (task, execution) => {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        systemPrompt: "You are a bounded read-only Sandora worker. Inspect the workspace with workspace_read, workspace_search, and workspace_list. Return a concise evidence-backed report. Never claim edits, commands, commits, pushes, or deployment.",
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
      });
      await loader.reload();
      const workerTools = createCodingTools().filter(tool => ["workspace_read", "workspace_search", "workspace_list"].includes(tool.name));
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model,
        thinkingLevel,
        resourceLoader: loader,
        noTools: "builtin",
        tools: workerTools.map(tool => tool.name),
        customTools: workerTools,
        sessionManager: SessionManager.inMemory(cwd),
      });
      const abort = () => { void session.abort(); };
      execution.signal.addEventListener("abort", abort, { once: true });
      try {
        await session.prompt(task);
        return { result: session.getLastAssistantText() || "(worker returned no text)" };
      } finally {
        execution.signal.removeEventListener("abort", abort);
        session.dispose();
      }
    },
  });

  return defineTool({
    name: "delegate_subagents",
    label: "Delegate subagents",
    description: "Run up to four independent read-only codebase exploration, debugging, review, or research tasks concurrently in isolated Pi sessions. Workers cannot edit files or run processes.",
    parameters: Type.Object({ tasks: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_WORKERS }) }),
    execute: async (_id, params, signal) => {
      const tasks = params?.tasks;
      if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > MAX_WORKERS) throw new Error(`tasks must contain 1-${MAX_WORKERS} items`);
      const runId = stableId("pi-workers", randomUUID());
      const pending = manager.start(tasks.map((prompt, index) => ({ id: `worker-${index + 1}`, prompt, budget: { wallTimeMs: WORKER_TIMEOUT_MS } })), { runId });
      const cancel = () => manager.cancel(runId);
      if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
      try {
        const status = await pending;
        return {
          content: [{ type: "text", text: status.tasks.map((task, index) => `WORKER ${index + 1} · ${task.status}\n${task.result || task.error || "(no result)"}`).join("\n\n") }],
          details: { runId, workerCount: tasks.length, runtime: "pi" },
        };
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
  });
}
