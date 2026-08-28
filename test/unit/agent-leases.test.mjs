import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskLeaseManager } from "../../src/agents/leases.mjs";
import { SandoraAgentManager, stableId } from "../../src/agents/manager.mjs";

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

test("two managers sharing leases invoke exactly one owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-leases-"));
  let calls = 0;
  const runner = async () => { calls += 1; await delay(50); return "done"; };
  try {
    const options = { runner, leaseRoot: root, leaseTtlMs: 60_000 };
    const one = new SandoraAgentManager(options);
    const two = new SandoraAgentManager(options);
    const tasks = [{ id: "same", prompt: "work" }];
    const [first, second] = await Promise.all([one.start(tasks, { runId: "run-shared", idempotencyKey: "shared" }), two.start(tasks, { runId: "run-shared", idempotencyKey: "shared" })]);
    assert.equal(calls, 1);
    assert.deepEqual([first.tasks[0].status, second.tasks[0].status].sort(), ["completed", "failed"]);
    assert.match([first.tasks[0].error, second.tasks[0].error].filter(Boolean)[0], /OWNER_BUSY|RECONCILE_REQUIRED/);
    const lease = JSON.parse(await readFile(join(root, createHash("sha256").update(`run-shared\0${stableId("agent", "same")}`).digest("hex"), "lease.json"), "utf8"));
    assert.equal(lease.state, "COMPLETED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expired and tampered leases require reconciliation and stale owners are fenced", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-lease-fence-"));
  let now = Date.now();
  const manager = new FileTaskLeaseManager({ leaseRoot: root, ownerId: "owner-a", ttlMs: 1_000, now: () => now });
  try {
    const lease = await manager.acquire({ runId: "run-one", agentId: "agent-one", attempt: 1, idempotencyKey: "identity" });
    await manager.transition(lease, "RUNNING");
    now += 2_000;
    const contender = new FileTaskLeaseManager({ leaseRoot: root, ownerId: "owner-b", ttlMs: 1_000, now: () => now });
    await assert.rejects(() => contender.acquire({ runId: "run-one", agentId: "agent-one", attempt: 2, idempotencyKey: "identity" }), /RECONCILE_REQUIRED/);

    const recordPath = manager.path("run-one", "agent-one");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(recordPath, JSON.stringify({ ...record, fenceToken: "replacement" }));
    await assert.rejects(() => manager.transition(lease, "COMPLETED"), /LEASE_FENCED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("terminal leases block automatic replay after manager restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-lease-terminal-"));
  let calls = 0;
  const runner = async () => { calls += 1; return "done"; };
  try {
    const first = new SandoraAgentManager({ runner, leaseRoot: root });
    assert.equal((await first.start([{ id: "one", prompt: "work" }], { runId: "run-terminal", idempotencyKey: "same" })).tasks[0].status, "completed");
    const restarted = new SandoraAgentManager({ runner, leaseRoot: root });
    const status = await restarted.start([{ id: "one", prompt: "work" }], { runId: "run-terminal", idempotencyKey: "same" });
    assert.equal(status.tasks[0].status, "failed");
    assert.match(status.tasks[0].error, /LEASE_TERMINAL/);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
