import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false, ...options });
  child.once("error", reject);
  child.once("close", (code, signal) => resolvePromise({ code, signal }));
});

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (packageJson.lockfileVersion !== undefined) throw new Error("package.json unexpectedly contains lockfile metadata");
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
if (lock.lockfileVersion !== 3) throw new Error(`unsupported lockfile version: ${lock.lockfileVersion}`);

const checks = [
  [process.execPath, ["--check", "start.mjs"]],
  [process.execPath, ["--check", "src/cli/terminal-app.mjs"]],
  [process.execPath, ["--check", "src/cli/headless-jsonl.mjs"]],
  [process.execPath, ["--check", "src/runtime/native-agent-session.mjs"]],
  [process.execPath, ["--check", "src/runtime/pi-agent-session.mjs"]],
  [process.execPath, ["--check", "src/runtime/create-session.mjs"]],
  [process.execPath, ["--check", "src/tools/registry.mjs"]],
  [process.execPath, ["--check", "src/agents/subagents.mjs"]],
  [process.execPath, ["--check", "src/agents/pi-subagents.mjs"]],
  [process.execPath, ["--check", "src/agents/pi-writable-workers.mjs"]],
  [process.execPath, ["--check", "src/plugins/host.mjs"]],
  [process.execPath, ["--check", "src/plugins/runtime.mjs"]],
  [process.execPath, ["--test"]],
  [process.execPath, ["scripts/cli-smoke.mjs"]],
];
for (const [command, args] of checks) {
  const result = await run(command, args);
  if (result.code !== 0) process.exit(result.code || 1);
}

// A deterministic process-lifecycle smoke test catches orphaned child processes without
// requiring provider credentials or a network-backed model.
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: root, stdio: "ignore" });
child.kill();
const exit = await new Promise((resolvePromise) => child.once("close", (code, signal) => resolvePromise({ code, signal })));
if (exit.signal !== "SIGTERM" && exit.signal !== "SIGKILL") throw new Error(`fixture process was not terminated: ${JSON.stringify(exit)}`);
console.log("QA smoke: syntax, tests, lockfile, and fixture process cleanup passed");
