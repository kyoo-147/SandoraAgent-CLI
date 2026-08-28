import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, reduceAgentEvent, cleanupOutput } from "../../src/runtime/event-reducer.mjs";

test("normalizes streamed output into one assistant message and accumulates usage", () => {
  let state = createInitialState();
  state = reduceAgentEvent(state, { type: "agent.start" });
  state = reduceAgentEvent(state, { type: "text.delta", delta: "hello", now: 100 });
  state = reduceAgentEvent(state, { type: "text.delta", delta: " world", now: 101 });
  state = reduceAgentEvent(state, { type: "message.end", role: "assistant", usage: { input: 4, output: 2, cacheRead: 1, cost: 0.01 } });
  assert.deepEqual(state.messages, [{ role: "assistant", text: "hello world" }]);
  assert.equal(state.status, "COMPLETE");
  assert.deepEqual(state.usage, { input: 4, output: 2, cacheRead: 1, cost: 0.01 });
  assert.equal(state.responseStartedAt, 100);
});

test("abort stops activity and removes an empty partial output", () => {
  let state = { ...createInitialState(), streaming: true, abortRequested: true, activity: "Writing response", messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "" }] };
  state = reduceAgentEvent(state, { type: "run.abort" });
  assert.equal(state.streaming, false);
  assert.equal(state.status, "READY");
  assert.equal(state.activity, "");
  assert.equal(state.abortRequested, false);
  assert.deepEqual(state.messages, [{ role: "user", text: "hi" }]);
});

test("cleanupOutput never discards a non-empty response", () => {
  const state = { ...createInitialState(), messages: [{ role: "assistant", text: "partial" }] };
  assert.equal(cleanupOutput(state).messages[0].text, "partial");
});

test("tool lifecycle exposes concise task-specific activity states", () => {
  const cases = [
    ["workspace_read", "READING"],
    ["workspace_search", "SEARCHING"],
    ["workspace_edit", "EDITING"],
    ["delegate_subagents", "SUBAGENTS"],
    ["git_commit", "COMMITTING"],
    ["git_push", "PUSHING"],
    ["browser_observe", "BROWSER"],
    ["workspace_shell", "RUNNING"],
  ];
  for (const [name, expected] of cases) assert.equal(reduceAgentEvent(createInitialState(), { type: "tool.start", name }).status, expected);
  assert.equal(reduceAgentEvent(createInitialState(), { type: "tool.start", name: "workspace_shell", args: { command: "npm test" } }).status, "TESTING");
  assert.match(reduceAgentEvent(createInitialState(), { type: "tool.end", name: "workspace_shell", isError: true }).activity, /Diagnosing/);
});
