import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

function runNode(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("exit", code => resolve({ code, stdout, stderr }));
  });
}

test("native core starts and prompts without loading the Pi package", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-no-pi-"));
  const loader = join(root, "block-pi-loader.mjs");
  try {
    await writeFile(loader, `export async function resolve(specifier, context, nextResolve) { if (specifier.startsWith("@earendil-works/pi")) throw new Error("PI_IMPORT_BLOCKED:" + specifier); return nextResolve(specifier, context); }\n`, "utf8");
    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "runtime", "create-session.mjs")).href;
    const script = `import { createSandoraSession } from ${JSON.stringify(moduleUrl)}; const provider={model:"fixture",async *stream(){yield {type:"text_delta",delta:"native-ok"}}}; const session=await createSandoraSession({core:"native",cwd:${JSON.stringify(root)},provider,pluginIds:[]}); const result=await session.prompt("hello"); console.log(result.message.content); await session.dispose();`;
    const result = await runNode(["--no-warnings", "--experimental-loader", pathToFileURL(loader).href, "--input-type=module", "--eval", script], { cwd: process.cwd(), env: { ...process.env, SANDORA_AGENT_CORE: "native" } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /native-ok/);
    assert.doesNotMatch(result.stderr, /PI_IMPORT_BLOCKED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
