import test from "node:test";
import assert from "node:assert/strict";
import { SandoraAgentManager, stableId } from "../../src/agents/manager.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("stable IDs and isolated execution boundaries are deterministic", async () => {
  const seen = [];
  const manager = new SandoraAgentManager({ maxConcurrency: 2, runner: async (prompt, execution) => {
    seen.push({ prompt, execution });
    return { result: prompt.toUpperCase(), artifacts: [`${execution.agentId}.json`] };
  } });
  const first = await manager.start([
    { id: "b", prompt: "second", config: { temperature: 0 }, context: { branch: "b" }, tools: ["read"], model: "m", budget: 20 },
    { id: "a", prompt: "first", config: { temperature: 1 }, context: { branch: "a" }, tools: ["search"], model: "n", budget: 10 },
  ]);
  assert.equal(first.tasks[0].agentId, stableId("agent", "a"));
  assert.equal(first.tasks[1].agentId, stableId("agent", "b"));
  assert.equal(seen[0].execution.agentId, stableId("agent", "a"));
  assert.deepEqual(seen[0].execution.context, { branch: "a" });
  assert.deepEqual(manager.result(first.runId, stableId("agent", "b")).artifacts.length, 1);
  assert.notEqual((await manager.start([{ id: "b", prompt: "ignored" }, { id: "a", prompt: "ignored" }])).runId, first.runId);
});

test("ramping is bounded and failures do not stop other agents", async () => {
  let active = 0; let peak = 0;
  const manager = new SandoraAgentManager({ maxConcurrency: 3, rampStep: 1, runner: async (prompt) => {
    active += 1; peak = Math.max(peak, active); await delay(5); active -= 1;
    if (prompt === "bad") throw new Error("boom");
    return prompt;
  } });
  const status = await manager.start(["bad", "one", "two", "three"].map((prompt, i) => ({ id: String(i), prompt })));
  assert.ok(peak <= 3);
  assert.equal(status.tasks.filter((task) => task.status === "failed").length, 1);
  assert.equal(status.tasks.filter((task) => task.status === "completed").length, 3);
});

test("cancel aborts active work and resume retries only unfinished agents", async () => {
  let calls = 0;
  const manager = new SandoraAgentManager({ maxConcurrency: 1, runner: async (_prompt, { signal }) => {
    calls += 1;
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 100); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); });
    return "done";
  } });
  const pending = manager.start([{ id: "x", prompt: "work" }], { runId: "run-x" });
  await delay(5);
  const runId = "run-x";
  assert.equal(manager.cancel(runId), true);
  const cancelled = await pending;
  assert.equal(cancelled.tasks[0].status, "cancelled");
  const resumed = await manager.resume(runId);
  assert.equal(resumed.tasks[0].status, "completed");
  assert.equal(calls, 2);
});

test("stress run preserves deterministic queue order under the concurrency ceiling", async () => {
  const order = []; let active = 0; let peak = 0;
  const manager = new SandoraAgentManager({ maxConcurrency: 4, rampStep: 2, runner: async (prompt) => {
    active += 1; peak = Math.max(peak, active); order.push(prompt); await delay(1); active -= 1; return prompt;
  } });
  const tasks = Array.from({ length: 40 }, (_, i) => ({ id: `agent-${String(i).padStart(2, "0")}`, prompt: `p${i}` }));
  const status = await manager.start([...tasks].reverse());
  assert.equal(status.tasks.every((task) => task.status === "completed"), true);
  assert.ok(peak <= 4);
  assert.deepEqual(order, tasks.map((task) => task.prompt));
});

test("task dependencies gate execution and failed prerequisites block dependents", async () => {
  const order = [];
  const manager = new SandoraAgentManager({ maxConcurrency: 3, rampStep: 3, runner: async prompt => { order.push(prompt); if (prompt === "fail") throw new Error("broken prerequisite"); return prompt; } });
  const status = await manager.start([
    { id: "final", prompt: "final", dependencies: ["middle"] },
    { id: "middle", prompt: "middle", dependsOn: ["root"] },
    { id: "root", prompt: "root" },
    { id: "blocked", prompt: "blocked", dependencies: ["failure"] },
    { id: "failure", prompt: "fail" },
  ]);
  assert.deepEqual(order, ["fail", "root", "middle", "final"]);
  assert.equal(status.tasks.find(task => task.key === "blocked").status, "blocked");
  assert.match(status.tasks.find(task => task.key === "blocked").error, /failure/);
  assert.deepEqual(status.tasks.find(task => task.key === "final").dependencies, ["middle"]);
});

test("task dependency graphs reject missing nodes and cycles before dispatch", () => {
  let calls = 0;
  const manager = new SandoraAgentManager({ runner: async () => { calls += 1; } });
  assert.throws(() => manager.start([{ id: "a", dependencies: ["missing"] }]), /unknown task dependency/);
  assert.throws(() => manager.start([{ id: "a", dependencies: ["b"] }, { id: "b", dependencies: ["a"] }]), /dependency cycle/);
  assert.equal(calls, 0);
});
