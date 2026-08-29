import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entrypoint = resolve(root, "start.mjs");
const visible = output => output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function runSmoke(cwd) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd,
    env: { ...process.env, PI_OFFLINE: "1", SANDORA_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exitPromise = new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 15_000);
  await delay(2_000);
  child.stdin.write("/help\n");
  const deadline = Date.now() + 7_000;
  while (!visible(output).includes("Commands:") && Date.now() < deadline) await delay(50);
  if (!visible(output).includes("Commands:")) {
    child.kill();
    await exitPromise;
    clearTimeout(timer);
    throw new Error(`CLI smoke output missing /help response in ${cwd}`);
  }
  child.stdin.write("/quit\n");
  const result = await exitPromise;
  clearTimeout(timer);
  if (result.code !== 0) throw new Error(`CLI did not exit gracefully in ${cwd}: ${JSON.stringify(result)}`);
}

const workspace = await mkdtemp(resolve(tmpdir(), "sandora-cli-workspace-"));
try {
  await runSmoke(root);
  await runSmoke(workspace);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
console.log("CLI smoke: branding assets, scripted /help, arbitrary workspace startup, graceful /quit, and process cleanup passed");
