import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const child = spawn(process.execPath, ["start.mjs"], {
  cwd: root,
  env: { ...process.env, PI_OFFLINE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const exitPromise = new Promise((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolvePromise({ code, signal }));
});
let output = "";
const visibleOutput = () => output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
const timer = setTimeout(() => child.kill(), 10_000);
await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500));
child.stdin.write("/help");
await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
child.stdin.write("\n");
const deadline = Date.now() + 5_000;
while (!visibleOutput().includes("Commands:") && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
const seenHelp = visibleOutput().includes("Commands:");
child.kill();
const result = await exitPromise;
clearTimeout(timer);
if (!seenHelp) throw new Error("CLI smoke output missing /help response");
if (result.code !== null) throw new Error(`CLI did not terminate from cleanup: ${JSON.stringify(result)}`);
console.log("CLI smoke: startup, scripted /help, and process cleanup passed");
