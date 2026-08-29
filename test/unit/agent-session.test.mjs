import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDisplayMessages, withRunLifecycle } from "../../src/runtime/agent-session.mjs";

function fakeSession(prompt) {
  const listeners = new Set();
  let disposed = false;
  return {
    sessionId: "fake",
    prompt,
    abort: async () => {},
    dispose: () => { disposed = true; },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    emit: event => { for (const listener of listeners) listener(event); },
    get disposed() { return disposed; },
  };
}

test("shared lifecycle emits ordered success and forwards source events", async () => {
  let source;
  source = fakeSession(async () => { source.emit({ type: "text.delta", delta: "ok" }); return "done"; });
  const session = withRunLifecycle(source);
  const events = [];
  const unsubscribe = session.subscribe(event => events.push(event));
  assert.equal(await session.prompt("hello"), "done");
  assert.deepEqual(events, [{ type: "run.start" }, { type: "text.delta", delta: "ok" }, { type: "run.complete" }]);
  unsubscribe();
  source.emit({ type: "text.delta", delta: "ignored" });
  session.dispose();
  assert.equal(source.disposed, true);
  assert.equal(events.length, 3);
});

test("shared lifecycle emits exactly one error or abort terminal", async () => {
  const failed = withRunLifecycle(fakeSession(async () => { throw new Error("boom"); }));
  const failureEvents = [];
  failed.subscribe(event => failureEvents.push(event));
  await assert.rejects(() => failed.prompt("fail"), /boom/);
  assert.deepEqual(failureEvents, [{ type: "run.start" }, { type: "run.error", error: "boom" }]);

  let rejectPrompt;
  const core = fakeSession(() => new Promise((_resolve, reject) => { rejectPrompt = reject; }));
  core.abort = async () => rejectPrompt(new Error("cancelled"));
  const aborted = withRunLifecycle(core);
  const abortEvents = [];
  aborted.subscribe(event => abortEvents.push(event));
  const pending = aborted.prompt("wait");
  await aborted.abort();
  await assert.rejects(() => pending, /cancelled/);
  assert.deepEqual(abortEvents, [{ type: "run.start" }, { type: "run.abort" }]);
});

test("display history keeps only bounded user and assistant text", () => {
  assert.deepEqual(normalizeDisplayMessages([
    { role: "system", content: "hidden" },
    { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", data: "hidden" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "answer" }, { type: "toolCall", name: "secret" }] },
    { role: "tool", content: "tool output" },
  ]), [{ role: "user", text: "hello" }, { role: "assistant", text: "answer" }]);
  assert.deepEqual(normalizeDisplayMessages([{ role: "user", content: "🙂🙂🙂" }], { maxMessages: 1, maxTextBytes: 8 }), [{ role: "user", text: "🙂🙂" }]);
});
