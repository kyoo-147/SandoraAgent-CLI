import test from "node:test";
import assert from "node:assert/strict";
import { normalizePiEvent } from "../../src/runtime/pi-agent-session.mjs";
import { DEFAULT_AGENT_CORE, createSandoraSession } from "../../src/runtime/create-session.mjs";

test("Pi events normalize into the Sandora UI contract", () => {
  assert.deepEqual(normalizePiEvent({ type: "agent_start" }), { type: "agent.start" });
  assert.deepEqual(normalizePiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }), { type: "text.delta", delta: "hi" });
  assert.deepEqual(normalizePiEvent({ type: "tool_execution_start", toolCallId: "1", toolName: "workspace_shell", args: { command: "npm test" } }), { type: "tool.start", id: "1", name: "workspace_shell", args: { command: "npm test" } });
  assert.deepEqual(normalizePiEvent({ type: "tool_execution_update", toolCallId: "1", toolName: "read", args: { path: "." }, partialResult: { content: [] } }), { type: "tool.update", id: "1", name: "read", args: { path: "." }, partialResult: { content: [] } });
  assert.deepEqual(normalizePiEvent({ type: "tool_execution_end", toolCallId: "1", toolName: "read", result: { content: [] }, isError: true }), { type: "tool.end", id: "1", name: "read", result: { content: [] }, isError: true });
  assert.deepEqual(normalizePiEvent({ type: "message_end", message: { role: "assistant", usage: { input: 5, output: 2, cacheRead: 1, cost: { total: 0.01 } } } }), {
    type: "message.end", role: "assistant", usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, total: 0, cost: 0.01 },
  });
  assert.deepEqual(normalizePiEvent({ type: "agent_end", willRetry: true }), { type: "agent.end", willRetry: true });
  assert.deepEqual(normalizePiEvent({ type: "agent_settled" }), { type: "agent.settled" });
  assert.deepEqual(normalizePiEvent({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false }), { type: "compaction.end", reason: "threshold", aborted: false, willRetry: false, error: undefined });
});

test("Pi is the default core and unsupported runtime values fail closed", async () => {
  assert.equal(DEFAULT_AGENT_CORE, "pi");
  await assert.rejects(() => createSandoraSession({ core: "other" }), /Expected pi or native/);
});
