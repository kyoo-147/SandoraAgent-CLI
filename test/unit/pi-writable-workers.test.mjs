import test from "node:test";
import assert from "node:assert/strict";
import { createPiWritableWorkerTools } from "../../src/agents/pi-writable-workers.mjs";

test("writable Pi worker surface separates run, inspect, integration, and cleanup authority", async () => {
  const tools = createPiWritableWorkerTools({ cwd: process.cwd() });
  assert.deepEqual(tools.map(tool => tool.name), ["delegate_writable_worker", "worker_recover", "worker_inspect", "worker_integrate", "worker_cleanup"]);
  assert.equal(tools[0].executionMode, "parallel");
  await assert.rejects(() => tools.find(tool => tool.name === "worker_integrate").execute("test", { workerId: "missing" }), /integration capability is disabled/);
});
