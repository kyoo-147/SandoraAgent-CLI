import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { SandoraAgentManager } from "../../src/agents/manager.mjs";
import { FileTaskRunStore } from "../../src/agents/run-store.mjs";

test("file run store restores completed task results without replay", async () => {
  const root = await mkdtemp(join(process.env.TEMP || "/tmp", "sandora-run-store-"));
  try {
    let calls = 0;
    const first = new SandoraAgentManager({ runStoreRoot: root, runner: async prompt => { calls++; return prompt; } });
    const initial = await first.start([{ id: "a", prompt: "A" }, { id: "b", prompt: "B", dependencies: ["a"] }], { runId: "durable" });
    assert.equal(initial.tasks.every(task => task.status === "completed"), true);
    const second = new SandoraAgentManager({ runStoreRoot: root, runner: async prompt => { calls++; return `replayed:${prompt}`; } });
    const restored = await second.restore("durable");
    assert.equal(restored.tasks.every(task => task.status === "completed"), true);
    assert.equal(calls, 2);
    assert.equal(second.result("durable", restored.tasks[0].agentId).result, restored.tasks[0].result);
  } finally { await rm(root, { recursive: true, force: true }); }
 });

test("file run store durably preserves cancellation without replay", async () => {
  const root = await mkdtemp(join(process.env.TEMP || "/tmp", "sandora-run-cancel-"));
  try {
    let calls = 0; let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const first = new SandoraAgentManager({ runStoreRoot: root, cancellationTimeoutMs: 0, runner: async (_prompt, { signal }) => { calls += 1; markStarted(); await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } });
    const pending = first.start([{ id: "active" }, { id: "dependent", dependencies: ["active"] }], { runId: "cancelled-run" });
    await started;
    assert.equal(first.cancel("cancelled-run"), true);
    const cancelled = await pending;
    assert.equal(cancelled.tasks.every(task => task.status === "cancelled"), true);
    const second = new SandoraAgentManager({ runStoreRoot: root, runner: async () => { calls += 1; return "unexpected"; } });
    const restored = await second.restore("cancelled-run");
    assert.equal(restored.tasks.every(task => task.status === "cancelled"), true);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restored in-flight task becomes reconcile-required without execution", async () => {
  const root = await mkdtemp(join(process.env.TEMP || "/tmp", "sandora-run-unknown-"));
  try {
    const store = new FileTaskRunStore({ root });
    const task = { key: "active", agentId: "agent-active", dependencies: [], status: "queued", attempts: 0, prompt: "side effect", artifacts: [] };
    await store.create({ runId: "interrupted", identity: "identity", tasks: [task] });
    const process = { pid: 4242, spawnedAt: "2026-08-29T00:00:00.000Z", entrypoint: "scripts/native-worker.mjs", childExitVerified: false, processTreeCleanupVerified: false };
    await store.event("interrupted", { agentId: task.agentId, patch: { status: "running", attempts: 1, dispatchIntentAt: "2026-08-29T00:00:00.000Z", process } });
    let calls = 0;
    const manager = new SandoraAgentManager({ runStore: store, runner: async () => { calls += 1; } });
    const restored = await manager.restore("interrupted");
    assert.equal(restored.tasks[0].status, "blocked");
    assert.match(restored.tasks[0].error, /RECONCILE_REQUIRED/);
    assert.deepEqual(restored.tasks[0].process, process);
    assert.equal(restored.tasks[0].dispatchIntentAt, "2026-08-29T00:00:00.000Z");
    assert.equal(calls, 0);
    assert.match((await store.read("interrupted")).tasks[0].error, /RECONCILE_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
