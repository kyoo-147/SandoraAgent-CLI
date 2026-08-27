import test from "node:test";
import assert from "node:assert/strict";
import { SandoraAgentManager } from "../src/agent-manager.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("rejects duplicate keys and normalized agent IDs", () => {
  const manager = new SandoraAgentManager({ runner: async () => "ok" });
  assert.throws(() => manager.start([{ id: "same" }, { key: "same" }]), /duplicate task key/);
  assert.throws(() => manager.start([{ id: "a", agentId: "same" }, { id: "b", agentId: "same" }]), /duplicate agent ID/);
});

test("default identity includes full task inputs", async () => {
  const manager = new SandoraAgentManager({ runner: async (prompt) => prompt });
  const a = await manager.start([{ id: "x", prompt: "one", config: { n: 1 } }]);
  const b = await manager.start([{ id: "x", prompt: "two", config: { n: 1 } }]);
  assert.notEqual(a.runId, b.runId);
});

test("resume preserves completed results and refuses active runs", async () => {
  let calls = 0;
  const manager = new SandoraAgentManager({ maxConcurrency: 1, runner: async (prompt) => { calls += 1; if (prompt === "bad" && calls === 2) throw new Error("retry"); return prompt; } });
  const first = await manager.start([{ id: "done", prompt: "good" }, { id: "retry", prompt: "bad" }], { runId: "preserve" });
  const resumed = await manager.resume("preserve");
  assert.equal(resumed.tasks.find((t) => t.key === "done").result, "good");
  assert.equal(first.tasks.find((t) => t.key === "done").result, "good");
  const manager2 = new SandoraAgentManager({ runner: async () => { await wait(30); return "ok"; } });
  const pending = manager2.start([{ id: "x" }], { runId: "active" });
  await wait(2);
  assert.throws(() => manager2.resume("active"), /cannot resume/);
  manager2.cancel("active");
  await pending;
});

test("snapshots and results cannot be mutated by callers", async () => {
  const manager = new SandoraAgentManager({ runner: async () => ({ result: { nested: 1 }, artifacts: [{ name: "a" }] }) });
  const status = await manager.start([{ id: "x" }], { runId: "immutable" });
  assert.throws(() => { status.tasks[0].status = "failed"; });
  const result = manager.result("immutable", status.tasks[0].agentId);
  assert.throws(() => { result.artifacts[0].name = "changed"; });
  assert.equal(manager.result("immutable", status.tasks[0].agentId).artifacts[0].name, "a");
});

test("uncooperative cancellation settles within the configured bound", async () => {
  const manager = new SandoraAgentManager({ cancellationTimeoutMs: 10, runner: async () => new Promise(() => {}) });
  const pending = manager.start([{ id: "hang" }], { runId: "bounded-cancel" });
  await wait(2); manager.cancel("bounded-cancel");
  const status = await Promise.race([pending, wait(100).then(() => "hung")]);
  assert.notEqual(status, "hung");
  assert.equal(status.tasks[0].status, "cancelled");
});

test("enforces wall-time budget and reports unsupported fields", async () => {
  let seen;
  const manager = new SandoraAgentManager({ runner: async (_prompt, execution) => { seen = execution; await wait(50); return "late"; } });
  const status = await manager.start([{ id: "slow", budget: { wallTimeMs: 5, tokens: 10 } }], { runId: "budget" });
  assert.equal(status.tasks[0].status, "cancelled");
  assert.match(status.tasks[0].error, /wall-time/);
  assert.deepEqual(seen.budget.unsupported, ["tokens"]);
});
