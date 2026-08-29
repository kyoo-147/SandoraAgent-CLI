import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandoraAgentManager } from "../../src/agents/manager.mjs";
import { FileTaskRunStore } from "../../src/agents/run-store.mjs";
import { createNativeWorkerRunner } from "../../src/agents/native-worker-runner.mjs";

const cwd = new URL("../..", import.meta.url).pathname;
const adapter = "test/fixtures/native-worker-adapter.mjs";
const execution = (signal, extra = {}) => ({ runId: "run-test", taskId: "task-test", attemptId: "attempt-test", signal, ...extra });

test("native worker returns bounded protocol result and reports process identity", async () => {
  const reports = [];
  const result = await createNativeWorkerRunner({ cwd, workerAdapter: adapter })("hello", execution(undefined, { reportProcess: async evidence => reports.push(evidence) }));
  assert.equal(result.result, "fixture:hello");
  assert.equal(result.process.childExitVerified, true);
  assert.equal(result.process.processTreeCleanupVerified, false);
  assert.equal(reports.length, 1); assert.equal(reports[0].childExitVerified, false);
});

test("native worker cancellation terminates hung direct child", async () => {
  const controller = new AbortController();
  const pending = createNativeWorkerRunner({ cwd, workerAdapter: adapter, timeoutMs: 5000 })("hang", execution(controller.signal));
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, error => /cancelled/.test(error.message) && error.process?.childExitVerified === true);
});

test("native worker rejects oversized result", async () => {
  await assert.rejects(createNativeWorkerRunner({ cwd, workerAdapter: adapter })("overflow", execution()), /result exceeds|invalid worker output|exited/);
});

test("native worker times out and verifies direct child exit", async () => {
  const pending = createNativeWorkerRunner({ cwd, workerAdapter: adapter, timeoutMs: 30, killGraceMs: 20 })("hang", execution());
  await assert.rejects(pending, error => /timeout/.test(error.message) && error.process?.childExitVerified === true);
});

test("native worker rejects malformed stdout and independently capped stderr", async () => {
  await assert.rejects(createNativeWorkerRunner({ cwd, workerAdapter: adapter })("malformed", execution()), /expected one result/);
  await assert.rejects(createNativeWorkerRunner({ cwd, workerAdapter: adapter, maxStderrBytes: 100, killGraceMs: 20 })("noisy", execution()), error => /stderr exceeded/.test(error.message) && error.process?.childExitVerified === true);
});

test("native worker preserves spawn failures and validates output caps", async () => {
  await assert.rejects(createNativeWorkerRunner({ cwd, workerAdapter: adapter, nodePath: "Z:/definitely-missing-node.exe" })("x", execution()), /worker spawn failed/);
  for (const options of [{ maxLineBytes: 0 }, { maxLineBytes: Number.POSITIVE_INFINITY }, { maxLineBytes: 256 * 1024 + 1 }, { maxStderrBytes: 0 }, { maxStderrBytes: 16 * 1024 + 1 }]) {
    assert.throws(() => createNativeWorkerRunner({ cwd, workerAdapter: adapter, ...options }), /output limits/);
  }
});

test("native worker spawn failure becomes a durable failed manager task", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-worker-spawn-failure-"));
  try {
    const store = new FileTaskRunStore({ root });
    const manager = new SandoraAgentManager({ runStore: store, runner: createNativeWorkerRunner({ cwd, workerAdapter: adapter, nodePath: "Z:/definitely-missing-node.exe" }) });
    const status = await manager.start([{ id: "spawn", prompt: "x" }], { runId: "spawn-failure" });
    assert.equal(status.tasks[0].status, "failed");
    assert.match(status.tasks[0].error, /worker spawn failed/);
    const saved = await store.read("spawn-failure");
    assert.equal(saved.tasks[0].status, "failed");
    assert.match(saved.tasks[0].error, /worker spawn failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native worker filters secrets and exposes only read-only registry tools", async () => {
  const previous = process.env.SANDORA_SECRET_TEST; process.env.SANDORA_SECRET_TEST = "must-not-cross";
  try {
    const result = await createNativeWorkerRunner({ cwd, workerAdapter: adapter })("environment", execution());
    assert.deepEqual(JSON.parse(result.result), { secret: null, tools: ["workspace_read", "workspace_search", "workspace_list"] });
  } finally { if (previous === undefined) delete process.env.SANDORA_SECRET_TEST; else process.env.SANDORA_SECRET_TEST = previous; }
});
