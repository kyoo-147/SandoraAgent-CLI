import test from "node:test";
import assert from "node:assert/strict";
import { delegateSubagentsTool } from "../src/subagents.mjs";

test("delegate_subagents exposes a bounded parallel worker tool", () => {
  assert.equal(delegateSubagentsTool.name, "delegate_subagents");
  assert.match(delegateSubagentsTool.description, /read-only/);
  assert.equal(delegateSubagentsTool.parameters.type, "object");
  assert.equal(delegateSubagentsTool.parameters.properties.tasks.type, "array");
  assert.equal(delegateSubagentsTool.parameters.properties.tasks.maxItems, 4);
});

test("worker extension registers only bounded workspace tools", async () => {
  const { default: workerTools } = await import("../src/worker-tools.mjs");
  const names = [];
  workerTools({ registerTool: (tool) => names.push(tool.name) });
  assert.deepEqual(names, ["workspace_read", "workspace_search", "workspace_list"]);
});
