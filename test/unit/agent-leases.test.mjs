import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTaskLeaseManager } from "../../src/agents/leases.mjs";
import { SandoraAgentManager, stableId } from "../../src/agents/manager.mjs";

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

test("two managers sharing leases invoke exactly one owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-leases-")); let calls = 0;
  const runner = async () => { calls += 1; await delay(50); return "done"; };
  try {
    const options = { runner, leaseRoot: root, leaseTtlMs: 60_000 };
    const [first, second] = await Promise.all([new SandoraAgentManager(options).start([{ id: "same", prompt: "work" }], { runId: "run-shared", idempotencyKey: "shared" }), new SandoraAgentManager(options).start([{ id: "same", prompt: "work" }], { runId: "run-shared", idempotencyKey: "shared" })]);
    assert.equal(calls, 1);
    assert.deepEqual([first.tasks[0].status, second.tasks[0].status].sort(), ["completed", "failed"]);
    assert.match([first.tasks[0].error, second.tasks[0].error].filter(Boolean)[0], /OWNER_BUSY|RECONCILE_REQUIRED/);
    const lease = JSON.parse(await readFile(join(root, createHash("sha256").update(`run-shared\0${stableId("agent", "same")}`).digest("hex"), "lease.json"), "utf8"));
    assert.equal(lease.state, "COMPLETED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expired ownership rejects late completion and explicit reconciliation fences it", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-lease-fence-")); let now = Date.now();
  const manager = new FileTaskLeaseManager({ leaseRoot: root, ownerId: "owner-a", ttlMs: 1_000, now: () => now });
  try {
    const lease = await manager.acquire({ runId: "run-one", agentId: "agent-one", attempt: 1, idempotencyKey: "identity" });
    await manager.transition(lease, "RUNNING"); now += 2_000;
    const contender = new FileTaskLeaseManager({ leaseRoot: root, ownerId: "owner-b", ttlMs: 1_000, now: () => now });
    await assert.rejects(() => contender.acquire({ runId: "run-one", agentId: "agent-one", attempt: 2, idempotencyKey: "identity" }), /RECONCILE_REQUIRED/);
    await assert.rejects(() => manager.transition(lease, "COMPLETED"), /LEASE_EXPIRED/);
    const resolved = await contender.reconcileExpired({ runId: "run-one", agentId: "agent-one", expectedFenceToken: lease.fenceToken, resolution: "CANCELLED" });
    assert.equal(resolved.state, "CANCELLED");
    assert.notEqual(resolved.fenceToken, lease.fenceToken);
    await assert.rejects(() => manager.transition(lease, "COMPLETED"), /LEASE_FENCED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("same-owner transitions serialize without overwriting terminal state", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-lease-cas-"));
  const manager = new FileTaskLeaseManager({ leaseRoot: root });
  try {
    const lease = await manager.acquire({ runId: "run-cas", agentId: "agent-cas", attempt: 1, idempotencyKey: "identity" });
    await manager.transition(lease, "RUNNING");
    const outcomes = await Promise.allSettled([manager.transition(lease, "COMPLETED", { reason: "complete" }), manager.transition(lease, "FAILED", { reason: "failed" })]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.match(outcomes.find(item => item.status === "rejected").reason.message, /terminal task lease/);
    const record = await manager.read("run-cas", "agent-cas");
    assert.ok(record.state === "COMPLETED" || record.state === "FAILED");
    assert.equal(record.reason, record.state === "COMPLETED" ? "complete" : "failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lease transition details cannot overwrite fenced identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-lease-details-")); const manager = new FileTaskLeaseManager({ leaseRoot: root });
  try {
    const lease = await manager.acquire({ runId: "run-details", agentId: "agent-details", attempt: 1, idempotencyKey: "identity" });
    await assert.rejects(() => manager.transition(lease, "RUNNING", { fenceToken: "forged", ownerId: "forged" }), /Invalid lease transition details/);
    const current = await manager.read("run-details", "agent-details");
    assert.equal(current.fenceToken, lease.fenceToken); assert.equal(current.ownerId, lease.ownerId); assert.equal(current.state, "ACQUIRED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed lease timestamps require reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-lease-malformed-")); const manager = new FileTaskLeaseManager({ leaseRoot: root });
  try {
    await manager.acquire({ runId: "run-bad", agentId: "agent-bad", attempt: 1, idempotencyKey: "identity" });
    const path = manager.path("run-bad", "agent-bad"); const record = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...record, expiresAt: "not-a-date" }));
    await assert.rejects(() => manager.read("run-bad", "agent-bad"), /RECONCILE_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancellation during lease acquisition never invokes runner", async () => {
  let release; const gate = new Promise(resolveGate => { release = resolveGate; }); let calls = 0; let acquired;
  const leaseManager = {
    async acquire() { await gate; acquired = { runId: "run-cancel", agentId: stableId("agent", "one"), fenceToken: "fence-token-for-cancel" }; return acquired; },
    async transition(_lease, state) { return { ...acquired, state }; },
  };
  const manager = new SandoraAgentManager({ leaseManager, runner: async () => { calls += 1; } });
  const pending = manager.start([{ id: "one", prompt: "work" }], { runId: "run-cancel" });
  await delay(5); assert.equal(manager.cancel("run-cancel"), true); release();
  const status = await pending;
  assert.equal(calls, 0); assert.equal(status.tasks[0].status, "cancelled");
});

test("terminal leases block automatic replay after manager restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-lease-terminal-")); let calls = 0; const runner = async () => { calls += 1; return "done"; };
  try {
    assert.equal((await new SandoraAgentManager({ runner, leaseRoot: root }).start([{ id: "one", prompt: "work" }], { runId: "run-terminal", idempotencyKey: "same" })).tasks[0].status, "completed");
    const status = await new SandoraAgentManager({ runner, leaseRoot: root }).start([{ id: "one", prompt: "work" }], { runId: "run-terminal", idempotencyKey: "same" });
    assert.equal(status.tasks[0].status, "failed"); assert.match(status.tasks[0].error, /LEASE_TERMINAL/); assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
