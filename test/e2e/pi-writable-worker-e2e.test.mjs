import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiWritableWorkerTools } from "../../src/agents/pi-writable-workers.mjs";

const execFile = promisify(execFileCallback);
const enabled = process.env.SANDORA_PI_E2E === "1";
const execute = (tools, name, params, cwd) => tools.find(tool => tool.name === name).execute("e2e", params, undefined, undefined, { cwd });

test("real writable Pi worker edits and commits in isolation before guarded integration", { skip: enabled ? false : "set SANDORA_PI_E2E=1 with Pi credentials to run writable-worker E2E", timeout: 300_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sandora-writable-worker-"));
  const agentDir = join(homedir(), ".pi", "agent");
  const previousAuthority = process.env.SANDORA_ALLOW_WORKER_INTEGRATION;
  try {
    await writeFile(join(cwd, "README.md"), "base\n");
    await execFile("git", ["init", "-q", "-b", "integration/e2e"], { cwd });
    await execFile("git", ["config", "user.email", "e2e@sandora.local"], { cwd });
    await execFile("git", ["config", "user.name", "Sandora E2E"], { cwd });
    await execFile("git", ["add", "README.md"], { cwd });
    await execFile("git", ["commit", "-qm", "base"], { cwd });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const model = modelRuntime.getModel("openai-codex", "gpt-5.6-luna");
    assert.ok(model, "GPT-5.6 Luna model must be available");
    const tools = createPiWritableWorkerTools({ cwd, agentDir, modelRuntime, model, thinkingLevel: "medium" });

    const result = await execute(tools, "delegate_writable_worker", { workerId: "writer-e2e", task: "Create worker.txt containing exactly WORKER_ISOLATED_OK followed by a newline. Verify the file, review Git status and diff, then commit only worker.txt with message 'feat: add worker evidence'." }, cwd);
    assert.equal(result.details.recoverable, true);
    await assert.rejects(() => readFile(join(cwd, "worker.txt")), /ENOENT/);
    const inspection = await execute(tools, "worker_inspect", { workerId: "writer-e2e" }, cwd);
    assert.match(inspection.content[0].text, /worker\.txt/);

    process.env.SANDORA_ALLOW_WORKER_INTEGRATION = "1";
    await execute(tools, "worker_integrate", { workerId: "writer-e2e" }, cwd);
    assert.equal((await readFile(join(cwd, "worker.txt"), "utf8")).replace(/\r\n/g, "\n"), "WORKER_ISOLATED_OK\n");
    const cleanup = await execute(tools, "worker_cleanup", { workerId: "writer-e2e" }, cwd);
    assert.equal(cleanup.details.workerId, "writer-e2e");
    assert.match(cleanup.content[0].text, /"cleaned": true/);
  } finally {
    if (previousAuthority === undefined) delete process.env.SANDORA_ALLOW_WORKER_INTEGRATION;
    else process.env.SANDORA_ALLOW_WORKER_INTEGRATION = previousAuthority;
    await rm(cwd, { recursive: true, force: true });
  }
});
