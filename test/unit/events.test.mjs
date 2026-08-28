import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "../../src/runtime/turn-runtime.mjs";
import { createEvent, EVENT_PROTOCOL, EVENT_SCHEMA_VERSION, normalizeEvent } from "../../src/runtime/events.mjs";

const runWorker = (path, streamId, prefix) => new Promise((resolveWorker, reject) => {
  const child = spawn(process.execPath, [join(process.cwd(), "scripts", "session-store-worker.mjs"), path, streamId, prefix, "20"], { stdio: "ignore" });
  child.once("error", reject); child.once("close", code => code === 0 ? resolveWorker() : reject(new Error(`session worker exited ${code}`)));
});

test("session store writes exact canonical envelopes and resumes messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-events-"));
  try {
    const store = new JsonlSessionStore(join(root, "events.jsonl"));
    const first = await store.append({ type: "user.message.accepted", message: { role: "user", content: "hello" } });
    const second = await store.append({ type: "turn.completed", payload: { status: "ok" } });
    assert.equal(first.protocol, EVENT_PROTOCOL); assert.equal(first.schemaVersion, EVENT_SCHEMA_VERSION);
    assert.deepEqual(Object.keys(first).sort(), ["actor", "id", "payload", "protocol", "schemaVersion", "sequence", "streamId", "timestamp", "type"].sort());
    assert.deepEqual(first.actor, { kind: "runtime", id: "sandora-native" });
    assert.equal(first.streamId, second.streamId); assert.equal(second.sequence, first.sequence + 1);
    assert.deepEqual(await store.resume(), [{ role: "user", content: "hello" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy and canonical replay normalize names and reject duplicate canonical IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-events-mixed-")); const path = join(root, "events.jsonl");
  try {
    const canonical = createEvent("user.message.accepted", { message: { role: "user", content: "new" } }, { id: "fixed", streamId: "stream", sequence: 2, timestamp: new Date(0).toISOString(), actor: { kind: "runtime", id: "test" } });
    await writeFile(path, `${JSON.stringify({ type: "message", message: { role: "user", content: "old" }, sequence: 1 })}\n${JSON.stringify(canonical)}\n`);
    const store = new JsonlSessionStore(path, { streamId: "stream" });
    assert.deepEqual((await store.resume()).map(message => message.content), ["old", "new"]);
    assert.deepEqual((await store.replay()).map(event => event.type), ["user.message.accepted", "user.message.accepted"]);
    await writeFile(path, `${JSON.stringify(canonical)}\n${JSON.stringify({ ...canonical, sequence: 3 })}\n`);
    await assert.rejects(() => store.replay(), /duplicate event id/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy normalization maps names and removes metadata from payload", () => {
  const normalized = normalizeEvent({ type: "tool.started", sequence: 4, secret: "must not persist" }, { streamId: "legacy", sequence: 4, index: 0 });
  assert.equal(normalized.protocol, EVENT_PROTOCOL); assert.equal(normalized.type, "tool.call.started");
  assert.equal(normalized.payload.secret, "[REDACTED]"); assert.equal(normalized.payload.sequence, undefined);
});

test("explicit and implicit stores reject foreign canonical streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-events-stream-")); const path = join(root, "events.jsonl");
  try {
    const foreign = createEvent("runtime.unknown", {}, { id: "foreign", streamId: "foreign-stream", sequence: 1, actor: { kind: "runtime", id: "test" } });
    await writeFile(path, `${JSON.stringify(foreign)}\n`);
    await assert.rejects(() => new JsonlSessionStore(path, { streamId: "owned-stream" }).replay(), /stream isolation/);
    await assert.rejects(() => new JsonlSessionStore(path).replay(), /stream isolation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("append rejects a supplied canonical event from a foreign stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-events-foreign-append-")); const path = join(root, "events.jsonl");
  try {
    const store = new JsonlSessionStore(path, { streamId: "owned" });
    const foreign = createEvent("runtime.unknown", {}, { streamId: "foreign", sequence: 1 });
    await assert.rejects(() => store.append(foreign), /streamId/);
    await assert.rejects(() => readFile(path, "utf8"), error => error.code === "ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("separate processes append unique contiguous sequences", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-events-process-")); const path = join(root, "events.jsonl");
  try {
    await Promise.all([runWorker(path, "shared", "a"), runWorker(path, "shared", "b")]);
    const events = await new JsonlSessionStore(path, { streamId: "shared" }).replay();
    assert.equal(events.length, 40); assert.deepEqual(events.map(event => event.sequence), Array.from({ length: 40 }, (_, index) => index + 1));
    assert.equal(new Set(events.map(event => event.id)).size, 40);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("serialized canonical events redact structured and textual secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-events-secret-")); const path = join(root, "events.jsonl");
  try {
    const store = new JsonlSessionStore(path);
    await store.append({ type: "turn.failed", error: 'provider failed {"apiKey":"TOPSECRET"} Authorization: Bearer OTHERSECRET https://x.test/?token=URLSECRET&auth=AUTHSECRET&sig=SIGSECRET', credential: "FIELDSECRET", headers: [{ name: "Authorization", value: "HEADERSECRET" }] });
    const bytes = await readFile(path, "utf8");
    for (const secret of ["TOPSECRET", "OTHERSECRET", "URLSECRET", "AUTHSECRET", "SIGSECRET", "FIELDSECRET", "HEADERSECRET"]) assert.doesNotMatch(bytes, new RegExp(secret));
    assert.match(bytes, /REDACTED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
