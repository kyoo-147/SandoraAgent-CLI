import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalInputSha256, ToolReceiptStore, wrapToolsWithReceipts } from "../../src/tools/receipts.mjs";

const rootFixture = () => mkdtemp(join(tmpdir(), "sandora-receipts-"));
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const reseal = record => { const unsealed = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "recordSha256")); return { ...unsealed, recordSha256: createHash("sha256").update(canonical(unsealed)).digest("hex") }; };
const runWorker = (root, marker) => new Promise((resolveWorker, reject) => {
  const child = spawn(process.execPath, [join(process.cwd(), "scripts", "receipt-worker.mjs"), root, marker], { stdio: "ignore" });
  child.once("error", reject);
  child.once("close", code => code === 0 ? resolveWorker() : reject(new Error(`receipt worker exited ${code}`)));
});
async function recordAt(root, sessionId) { const directory = join(root, ".sandora", "receipts", sessionId); const names = await readdir(directory); const name = names.find(item => item.endsWith(".terminal.json")) || names[0]; return { path: join(directory, name), record: JSON.parse(await readFile(join(directory, name), "utf8")) }; }

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
    const { record } = await recordAt(root, "session-one");
    const serialized = JSON.stringify(record);
    assert.doesNotMatch(serialized, /README|private output/);
    assert.equal(record.state, "SUCCEEDED");
    assert.equal(record.durability, "FILE_FSYNC");
    assert.equal(record.resultBytes, Buffer.byteLength("private output"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("independent stores atomically claim one tool call", async () => {
  const root = await rootFixture(); let calls = 0;
  try {
    const options = { cwd: root, sessionId: "shared", runtime: "pi" };
    const invoke = async () => { calls += 1; await new Promise(resolveDelay => setTimeout(resolveDelay, 25)); return "done"; };
    const outcomes = await Promise.allSettled([
      new ToolReceiptStore(options).execute({ toolCallId: "same", toolName: "workspace_write", args: { path: "x" }, invoke }),
      new ToolReceiptStore(options).execute({ toolCallId: "same", toolName: "workspace_write", args: { path: "x" }, invoke }),
    ]);
    assert.equal(calls, 1);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.match(outcomes.find(item => item.status === "rejected").reason.message, /TOOL_RECEIPT_UNKNOWN/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("separate processes cannot both claim the same tool call", async () => {
  const root = await rootFixture(); const marker = join(root, "effects.txt");
  try {
    await Promise.all([runWorker(root, marker), runWorker(root, marker)]);
    assert.equal(await readFile(marker, "utf8"), "x");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed or forged terminal receipt fails unknown", async () => {
  const root = await rootFixture();
  try {
    const receipts = new ToolReceiptStore({ cwd: root, sessionId: "tamper", runtime: "native" });
    await receipts.execute({ toolCallId: "one", toolName: "workspace_read", args: {}, invoke: async () => "done" });
    const { path, record } = await recordAt(root, "tamper");
    await writeFile(path, JSON.stringify(reseal({ ...record, unexpected: true })));
    await assert.rejects(() => receipts.execute({ toolCallId: "one", toolName: "workspace_read", args: {}, invoke: async () => "wrong" }), /TOOL_RECEIPT_UNKNOWN/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("wrapped tools preserve provider callback identity and record blocked outcomes", async () => {
  const root = await rootFixture();
  try {
    const [tool] = wrapToolsWithReceipts([{ name: "browser_click", execute: async () => { throw new Error("Browser consequential action blocked by policy"); } }], { cwd: root, sessionId: "session-two", runtime: "pi" });
    await assert.rejects(() => tool.execute("pi-call", { ref: "opaque" }), /blocked/);
    const { record } = await recordAt(root, "session-two");
    assert.equal(record.outcome, "BLOCKED");
    assert.equal(record.authority.variable, "SANDORA_ALLOW_BROWSER_SUBMIT");
    assert.doesNotMatch(JSON.stringify(record), /opaque|consequential action/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("browser launch receipts bind existing-profile authority when an endpoint is requested", async () => {
  const root = await rootFixture(); const previous = process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE;
  try {
    process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE = "1";
    const receipts = new ToolReceiptStore({ cwd: root, sessionId: "browser-profile", runtime: "native" });
    await receipts.execute({ toolCallId: "launch-existing", toolName: "browser_launch", args: { endpoint: "http://127.0.0.1:9222" }, invoke: async () => "connected" });
    const { record } = await recordAt(root, "browser-profile");
    assert.deepEqual(record.authority, { variable: "SANDORA_ALLOW_EXISTING_BROWSER_PROFILE", granted: true });
  } finally { if (previous === undefined) delete process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE; else process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE = previous; await rm(root, { recursive: true, force: true }); }
});

test("browser transfer receipts bind upload and retained-download authority", async () => {
  const root = await rootFixture();
  const previousUpload = process.env.SANDORA_ALLOW_BROWSER_UPLOAD, previousRetain = process.env.SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN;
  try {
    process.env.SANDORA_ALLOW_BROWSER_UPLOAD = "1"; process.env.SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN = "1";
    await new ToolReceiptStore({ cwd: root, sessionId: "upload", runtime: "native" }).execute({ toolCallId: "upload", toolName: "browser_upload", args: { sessionId: "opaque", ref: "fresh", path: "input.txt" }, invoke: async () => "uploaded" });
    await new ToolReceiptStore({ cwd: root, sessionId: "download", runtime: "native" }).execute({ toolCallId: "download", toolName: "browser_download_wait", args: { sessionId: "opaque", retainPath: "artifact.txt" }, invoke: async () => "retained" });
    assert.deepEqual((await recordAt(root, "upload")).record.authority, { variable: "SANDORA_ALLOW_BROWSER_UPLOAD", granted: true });
    assert.deepEqual((await recordAt(root, "download")).record.authority, { variable: "SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN", granted: true });
  } finally {
    if (previousUpload === undefined) delete process.env.SANDORA_ALLOW_BROWSER_UPLOAD; else process.env.SANDORA_ALLOW_BROWSER_UPLOAD = previousUpload;
    if (previousRetain === undefined) delete process.env.SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN; else process.env.SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN = previousRetain;
    await rm(root, { recursive: true, force: true });
  }
});
