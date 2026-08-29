import test from "node:test";
import assert from "node:assert/strict";
import { createPiWritableWorkerTools, WRITABLE_WORKER_CODING_TOOLS } from "../../src/agents/pi-writable-workers.mjs";

test("writable Pi worker surface separates run, inspect, integration, and cleanup authority", async () => {
  const tools = createPiWritableWorkerTools({ cwd: process.cwd() });
  assert.deepEqual(tools.map(tool => tool.name), ["delegate_writable_worker", "worker_recover", "worker_inspect", "worker_integrate", "worker_cleanup"]);
  assert.equal(tools[0].executionMode, "parallel");
  await assert.rejects(() => tools.find(tool => tool.name === "worker_integrate").execute("test", { workerId: "missing" }), /integration capability is disabled/);
});

test("writable worker implementation allow-list excludes deletion and shell access", () => {
  assert.deepEqual([...WRITABLE_WORKER_CODING_TOOLS], ["workspace_list", "workspace_read", "workspace_search", "workspace_write", "workspace_edit"]);
  assert.equal(WRITABLE_WORKER_CODING_TOOLS.has("workspace_delete"), false);
  assert.equal(WRITABLE_WORKER_CODING_TOOLS.has("workspace_shell"), false);
});
