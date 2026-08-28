import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalInputSha256, ToolReceiptStore, wrapToolsWithReceipts } from "../../src/tools/receipts.mjs";

const rootFixture = () => mkdtemp(join(tmpdir(), "sandora-receipts-"));

test("tool receipts canonicalize input and persist bounded terminal evidence", async () => {
  const root = await rootFixture();
  try {
    assert.equal(canonicalInputSha256({ b: 2, a: 1 }), canonicalInputSha256({ a: 1, b: 2 }));
    const receipts = new ToolReceiptStore({ cwd: root, sessionId: "session-one", runtime: "native" });
    let calls = 0;
    const result = await receipts.execute({ toolCallId: "call-one", toolName: "workspace_read", args: { path: "README.md" }, invoke: async () => { calls += 1; return { content: [{ type: "text", text: "private output" }] }; } });
    assert.equal(result.content[0].text, "private output");
    await assert.rejects(() => receipts.execute({ toolCallId: "call-one", toolName: "workspace_read", args: { path: "README.md" }, invoke: async () => { calls += 1; } }), /TOOL_RECEIPT_DUPLICATE/);
    await assert.rejects(() => receipts.execute({ toolCallId: "call-one", toolName: "workspace_read", args: { path: "other" }, invoke: async () => { calls += 1; } }), /TOOL_RECEIPT_COLLISION/);
    assert.equal(calls, 1);
    const transcript = await readFile(join(root, ".sandora", "receipts", "session-one.jsonl"), "utf8");
    assert.doesNotMatch(transcript, /README|private output/);
    const events = transcript.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.phase), ["started", "succeeded"]);
    assert.equal(events[0].sandbox, "UNAVAILABLE_APPLICATION_ONLY");
    assert.equal(events[1].resultBytes, Buffer.byteLength("private output"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("wrapped tools preserve provider callback identity and record blocked outcomes", async () => {
  const root = await rootFixture();
  try {
    const [tool] = wrapToolsWithReceipts([{ name: "browser_click", execute: async () => { throw new Error("Browser consequential action blocked by policy"); } }], { cwd: root, sessionId: "session-two", runtime: "pi" });
    await assert.rejects(() => tool.execute("pi-call", { ref: "opaque" }), /blocked/);
    const transcript = await readFile(join(root, ".sandora", "receipts", "session-two.jsonl"), "utf8");
    const events = transcript.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(events.at(-1).outcome, "BLOCKED");
    assert.equal(events.at(-1).authority.variable, "SANDORA_ALLOW_BROWSER_SUBMIT");
    assert.doesNotMatch(transcript, /opaque|consequential action/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
