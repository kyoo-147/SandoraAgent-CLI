import test from "node:test";
import assert from "node:assert/strict";
import { compactContext, groupMessages, measureContext, selectContextGroups, validateCompactionProvenance } from "../../src/runtime/context-budget.mjs";

const tagged = (message, id) => Object.defineProperty(message, "messageId", { value: id, enumerable: false });

test("context sizing is stable UTF-8 canonical JSON", () => {
  const a = tagged({ role: "user", content: "🙂 café" }, "a");
  const b = tagged({ content: "🙂 café", role: "user" }, "a");
  assert.equal(measureContext([a]).bytes, measureContext([b]).bytes);
  assert.equal(measureContext([a]).estimatedTokens, Math.ceil(measureContext([a]).bytes / 4));
});

test("tool calls and all results are indivisible and newest groups are selected", () => {
  const messages = [tagged({ role: "system", content: "S" }, "s"), tagged({ role: "user", content: "old" }, "u1"), tagged({ role: "assistant", content: "old answer" }, "a1"), tagged({ role: "user", content: "run" }, "u2"), tagged({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }, { id: "c2", type: "function", function: { name: "y", arguments: "{}" } }] }, "a2"), tagged({ role: "tool", tool_call_id: "c1", content: "one" }, "t1"), tagged({ role: "tool", tool_call_id: "c2", content: "two" }, "t2")];
  const groups = groupMessages(messages);
  assert.equal(groups.at(-1).messages.length, 4);
  assert.equal(groups.at(-1).messages[0].role, "user");
  const result = compactContext(messages, { maxBytes: measureContext([messages[0], ...messages.slice(3)]).bytes });
  assert.deepEqual(result.retainedMessageIds, ["s", "u2", "a2", "t1", "t2"]);
});

test("malformed tool adjacency fails closed", () => {
  assert.throws(() => groupMessages([{ role: "tool", tool_call_id: "x", content: "x" }]), /ORPHAN/);
  assert.throws(() => groupMessages([{ role: "assistant", tool_calls: [{ id: "x" }, { id: "x" }] }]), /DUPLICATE/);
  assert.throws(() => groupMessages([{ role: "assistant", tool_calls: [{ id: "x" }] }]), /INCOMPLETE/);
});

test("oversized atomic group fails closed", () => {
  const groups = groupMessages([{ role: "system", content: "s" }, { role: "user", content: "x".repeat(100) }]);
  assert.throws(() => selectContextGroups(groups, { maxBytes: 10 }), /TOO_LARGE/);
});

test("compaction provenance rejects source-range and count drift", () => {
  const messages = [tagged({ role: "system", content: "s" }, "s"), tagged({ role: "user", content: "u" }, "u")];
  const compacted = compactContext(messages, { maxBytes: 1000 });
  const provenance = { ...compacted, sourceMessageCount: 2, sourceEventRange: { first: "s", last: "u" } };
  assert.deepEqual(validateCompactionProvenance(provenance, messages), messages);
  assert.throws(() => validateCompactionProvenance({ ...provenance, sourceMessageCount: 3 }, messages), /source range/);
});

test("older oversized completed turns may be dropped while newest stays atomic", () => {
  const messages = [tagged({ role: "system", content: "s" }, "s"), tagged({ role: "user", content: "x".repeat(1000) }, "old-u"), tagged({ role: "assistant", content: "old" }, "old-a"), tagged({ role: "user", content: "new" }, "new-u")];
  const budget = measureContext([messages[0], messages[3]]).bytes;
  assert.deepEqual(compactContext(messages, { maxBytes: budget }).retainedMessageIds, ["s", "new-u"]);
});
