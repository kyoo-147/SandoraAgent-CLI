import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const piEntry = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

function runSubagent(task, cwd, index) {
  return new Promise((resolve) => {
    const args = process.platform === "win32"
      ? [piEntry, "--no-session", "--print", "--tools", "read,grep,find,ls,powershell", "--", task]
      : [piEntry, "--no-session", "--print", "--tools", "read,grep,find,ls,bash", "--", task];
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve(`Worker ${index + 1} failed to start: ${error.message}`));
    child.on("close", (code) => {
      const result = stdout.trim() || stderr.trim() || "(worker returned no text)";
      resolve(`WORKER ${index + 1} · exit ${code ?? "unknown"}\n${result}`);
    });
  });
}

export const delegateSubagentsTool = defineTool({
  name: "delegate_subagents",
  label: "Delegate subagents",
  description: "Run up to four independent read-only research, codebase exploration, debugging, testing, or review tasks in parallel. Workers must not edit files, commit, push, or deploy. Return their reports for the parent agent to synthesize.",
  parameters: Type.Object({
    tasks: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 4, description: "Independent read-only worker tasks" }),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const results = await Promise.all(params.tasks.map((task, index) => runSubagent(task, ctx.cwd, index)));
    return { content: [{ type: "text", text: results.join("\n\n") }], details: { workerCount: results.length } };
  },
});
