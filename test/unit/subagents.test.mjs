import test from "node:test";
import assert from "node:assert/strict";
import { delegateSubagentsTool } from "../../src/agents/subagents.mjs";

test("delegate_subagents exposes a bounded parallel worker tool", () => {
  assert.equal(delegateSubagentsTool.name, "delegate_subagents");
  assert.match(delegateSubagentsTool.description, /read-only/);
  assert.equal(delegateSubagentsTool.parameters.type, "object");
  assert.equal(delegateSubagentsTool.parameters.properties.tasks.type, "array");
  assert.equal(delegateSubagentsTool.parameters.properties.tasks.maxItems, 4);
});

test("worker extension registers only bounded workspace tools", async () => {
  const { default: workerTools } = await import("../../src/agents/worker-tools.mjs");
  const names = [];
  workerTools({ registerTool: (tool) => names.push(tool.name) });
  assert.deepEqual(names, ["workspace_read", "workspace_search", "workspace_list"]);
});

test("swarm contract stays bounded and read-only", () => {
  assert.equal(delegateSubagentsTool.parameters.properties.tasks.maxItems, 4);
  assert.match(delegateSubagentsTool.description, /cannot access paths outside the workspace/);
});

test("plugin worker surface contains no mutation or process tools", async () => {
  const { default: workerTools } = await import("../../src/agents/worker-tools.mjs");
  const registered = [];
  workerTools({ registerTool: (tool) => registered.push(tool) });
  assert.deepEqual(registered.map((tool) => tool.name), ["workspace_read", "workspace_search", "workspace_list"]);
  assert.equal(registered.some((tool) => /write|edit|exec|shell|process/i.test(tool.name)), false);
});
