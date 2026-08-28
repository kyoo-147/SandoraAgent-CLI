import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { GitWorktreeManager } from "../git/worktrees.mjs";
import { createGitTools } from "../git/tools.mjs";
import { createCodingTools } from "../tools/coding-tools.mjs";
import { runBounded } from "../tools/coding-tools.mjs";
import { defineTool } from "../tools/registry.mjs";

const WORKER_TIMEOUT_MS = 10 * 60_000;
const MAX_RESULT_BYTES = 20_000;

function text(value, details = {}) {
  const output = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: output.slice(0, MAX_RESULT_BYTES) + (output.length > MAX_RESULT_BYTES ? "\n[worker result truncated]" : "") }], details };
}

export function createPiWritableWorkerTools({ cwd, agentDir, modelRuntime, model, thinkingLevel = "medium" } = {}) {
  const manager = new GitWorktreeManager({ repoRoot: cwd });
  const workerId = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" });
  const ownershipToken = Type.String({ minLength: 8, maxLength: 256, pattern: "^[A-Za-z0-9._:-]+$" });
  const workerVerify = defineTool({
    name: "worker_verify",
    label: "Worker verify",
    description: "Run one allowlisted build or test profile in the isolated worker worktree. Arbitrary shell and Git/GitHub commands are not available.",
    parameters: Type.Object({ profile: Type.Union([Type.Literal("npm-test"), Type.Literal("npm-check"), Type.Literal("npm-build"), Type.Literal("npm-lint"), Type.Literal("node-test")]) }),
    execute: async (_id, params, signal, _update, ctx) => {
      const profiles = {
        "npm-test": [process.platform === "win32" ? "npm.cmd" : "npm", ["test"]],
        "npm-check": [process.platform === "win32" ? "npm.cmd" : "npm", ["run", "check"]],
        "npm-build": [process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]],
        "npm-lint": [process.platform === "win32" ? "npm.cmd" : "npm", ["run", "lint"]],
        "node-test": [process.execPath, ["--test"]],
      };
      const [command, args] = profiles[params.profile];
      return runBounded(command, args, { cwd: ctx.cwd, signal, timeoutMs: 120_000 });
    },
  });

  const run = defineTool({
    name: "delegate_writable_worker",
    label: "Delegate writable worker",
    description: "Run one explicitly named Pi worker in its own recoverable Git worktree. The worker may edit, test, review, and commit only on its isolated branch; it cannot push or merge.",
    executionMode: "parallel",
    parameters: Type.Object({ workerId, task: Type.String({ minLength: 1, maxLength: 20_000 }), baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
    execute: async (_toolCallId, params, signal) => {
      let meta;
      let session;
      const timeout = AbortSignal.timeout(WORKER_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        meta = await manager.create(params.workerId, { baseRef: params.baseRef || "HEAD" });
        const loader = new DefaultResourceLoader({
          cwd: meta.path,
          agentDir,
          systemPrompt: "You are a bounded Sandora implementation worker in an isolated Git worktree. Inspect the task, make only task-relevant edits, run relevant allowlisted tests with worker_verify, review your diff, and commit intended files on the existing worker branch. Arbitrary shell, push, merge, parent-worktree access, and unrelated deletion are unavailable. If blocked, preserve evidence and report honestly.",
          noExtensions: true,
          noPromptTemplates: true,
          noThemes: true,
        });
        await loader.reload();
        const allowedGit = new Set(["git_status", "git_diff", "git_history", "git_commit"]);
        const tools = [...createCodingTools().filter(tool => tool.name !== "workspace_shell"), workerVerify, ...createGitTools().filter(tool => allowedGit.has(tool.name))];
        const created = await createAgentSession({
          cwd: meta.path,
          agentDir,
          modelRuntime,
          model,
          thinkingLevel,
          resourceLoader: loader,
          noTools: "builtin",
          tools: tools.map(tool => tool.name),
          customTools: tools,
          sessionManager: SessionManager.inMemory(meta.path),
        });
        session = created.session;
        const abort = () => { void session.abort(); };
        combined.addEventListener("abort", abort, { once: true });
        try { await session.prompt(params.task); }
        finally { combined.removeEventListener("abort", abort); }
        const inspection = await manager.inspect(params.workerId, { ownershipToken: meta.ownershipToken });
        const diff = await manager.collectDiff(params.workerId, { ownershipToken: meta.ownershipToken });
        return text({ workerId: params.workerId, ownershipToken: meta.ownershipToken, status: combined.aborted ? "cancelled" : "completed", branch: meta.branch, worktree: meta.path, dirty: inspection.dirty, changed: diff.changed, report: session.getLastAssistantText() || "(no worker report)", patch: diff.patch || diff.workingPatch || "" }, { workerId: params.workerId, ownershipToken: meta.ownershipToken, branch: meta.branch, worktree: meta.path, recoverable: true });
      } catch (error) {
        const recovery = meta ? { workerId: params.workerId, ownershipToken: meta.ownershipToken, branch: meta.branch, worktree: meta.path, recoverable: true } : await manager.recoveryHandle(params.workerId).catch(() => null) || { workerId: params.workerId, recoverable: false };
        throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}${meta ? `; worker preserved at ${meta.path}` : ""}`), { recovery });
      } finally {
        session?.dispose();
      }
    },
  });

  const recover = defineTool({ name: "worker_recover", label: "Recover worker", description: "Classify or repair one owned interrupted worker creation without deleting work or branches.", parameters: Type.Object({ workerId, ownershipToken }), execute: async (_id, params) => text(await manager.recover(params.workerId, { ownershipToken: params.ownershipToken }), { workerId: params.workerId, recoverable: true }) });

  const inspect = defineTool({ name: "worker_inspect", label: "Inspect worker", description: "Inspect a recoverable writable worker using the ownership token returned at creation.", parameters: Type.Object({ workerId, ownershipToken }), execute: async (_id, params) => { const state = await manager.inspect(params.workerId, params); const diff = await manager.collectDiff(params.workerId, params); return text({ ...state, patch: diff.patch || diff.workingPatch || "" }, { workerId: params.workerId, ownershipToken: params.ownershipToken, recoverable: true }); } });

  const integrate = defineTool({ name: "worker_integrate", label: "Integrate worker", description: "Validate and merge an owned completed worker branch into the current clean branch only when SANDORA_ALLOW_WORKER_INTEGRATION=1 grants runtime authority.", parameters: Type.Object({ workerId, ownershipToken }), execute: async (_id, params) => { if (process.env.SANDORA_ALLOW_WORKER_INTEGRATION !== "1") throw new Error("Worker integration capability is disabled; set SANDORA_ALLOW_WORKER_INTEGRATION=1 with explicit authority"); const state = await manager.inspect(params.workerId, params); if (state.dirty) throw new Error("Refusing integration of a dirty worker; preserve or commit its changes first"); const diff = await manager.collectDiff(params.workerId, params); if (!diff.changed) throw new Error("Refusing integration of a worker with no committed changes"); const validation = await manager.validate(params.workerId, { ownershipToken: params.ownershipToken }); if (!validation.valid) throw new Error(`Worker validation failed: ${validation.diffCheck.stderr || validation.command.stderr}`); const result = await manager.integrate(params.workerId, { ownershipToken: params.ownershipToken }); return text(result, { workerId: params.workerId, integrated: true }); } });

  const cleanup = defineTool({ name: "worker_cleanup", label: "Clean worker", description: "Clean an owned worker only when it is clean and proven integrated; dirty or unintegrated work remains recoverable.", parameters: Type.Object({ workerId, ownershipToken }), execute: async (_id, params) => text(await manager.cleanup(params.workerId, { ownershipToken: params.ownershipToken }), { workerId: params.workerId }) });

  return [run, recover, inspect, integrate, cleanup];
}
