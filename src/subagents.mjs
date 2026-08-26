import process from "node:process";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const piEntry = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const MAX_WORKERS = 4;
const WORKER_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 20_000;

function workerEnvironment() {
  const allowed = new Set(["PATH", "PATHEXT", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PI_OFFLINE"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key)));
}

function terminate(child, force = false) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => {});
  } else {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

function runSubagent(task, cwd, index, signal) {
  if (signal?.aborted) return Promise.resolve(`WORKER ${index + 1} · cancelled before start`);
  return new Promise((resolve) => {
    const workerExtension = join(root, "src", "worker-tools.mjs");
    const args = [piEntry, "--no-session", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-builtin-tools", "--extension", workerExtension, "--print", "--tools", "workspace_read,workspace_search,workspace_list", "--", `Work only with the bounded workspace tools. Do not request unavailable tools. ${task}`];
    const child = spawn(process.execPath, args, { cwd, env: workerEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationReason = "";
    let killFallback;
    let forceFallback;
    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killFallback);
      clearTimeout(forceFallback);
      signal?.removeEventListener("abort", onAbort);
      resolve(text);
    };
    const onAbort = () => {
      terminationReason = "cancelled";
      terminate(child);
      killFallback = setTimeout(() => {
        terminate(child, true);
        forceFallback = setTimeout(() => finish(`WORKER ${index + 1} · cancelled (process did not exit promptly)`), 1_000);
      }, 5_000);
    };
    const timer = setTimeout(() => {
      terminationReason = `timed out after ${WORKER_TIMEOUT_MS / 1000}s`;
      terminate(child);
      killFallback = setTimeout(() => {
        terminate(child, true);
        forceFallback = setTimeout(() => finish(`WORKER ${index + 1} · ${terminationReason} (process did not exit promptly)`), 1_000);
      }, 5_000);
    }, WORKER_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT); });
    child.on("error", (error) => finish(`WORKER ${index + 1} · failed to start: ${error.message}`));
    child.on("close", (code) => {
      if (terminationReason) {
        finish(`WORKER ${index + 1} · ${terminationReason}; process exited ${code ?? "unknown"}`);
        return;
      }
      const result = stdout.trim() || stderr.trim() || "(worker returned no text)";
      finish(`WORKER ${index + 1} · exit ${code ?? "unknown"}\n${result}`);
    });
  });
}

export const delegateSubagentsTool = defineTool({
  name: "delegate_subagents",
  label: "Delegate subagents",
  executionMode: "sequential",
  description: "Run up to four independent read-only research, codebase exploration, debugging, testing, or review tasks in parallel. Workers use bounded workspace-only read/search/list tools and cannot access paths outside the workspace, edit files, commit, push, or deploy. Return reports for the parent agent to synthesize.",
  parameters: Type.Object({
    tasks: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_WORKERS, description: "Independent read-only worker tasks" }),
  }),
  execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
    const results = await Promise.all(params.tasks.map((task, index) => runSubagent(task, ctx.cwd, index, signal)));
    return { content: [{ type: "text", text: results.join("\n\n") }], details: { workerCount: results.length } };
  },
});
