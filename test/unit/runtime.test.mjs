import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, JsonlSessionStore, OpenAICompatibleProvider, runTurn } from "../../src/runtime/turn-runtime.mjs";

function sse(...events) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new TextEncoder().encode(body));
}

test("OpenAI-compatible provider parses streamed text and tool-call deltas", async () => {
  const provider = new OpenAICompatibleProvider({ model: "test", apiKey: "key", baseUrl: "http://local/v1", fetchImpl: async (url, options) => {
    assert.equal(url, "http://local/v1/chat/completions");
    assert.equal(options.headers.authorization, "Bearer key");
    const request = JSON.parse(options.body);
    assert.equal(request.stream, true);
    assert.deepEqual(request.stream_options, { include_usage: true });
    const text = { choices: [{ delta: { content: "hi" } }] };
    const firstCall = { choices: [{ delta: {} }] };
    firstCall.choices[0].delta.tool_calls = [{ index: 0, id: "c1", function: { name: "lookup", arguments: '{"q":' } }];
    const secondCall = { choices: [{ delta: {} }] };
    secondCall.choices[0].delta.tool_calls = [{ index: 0, function: { arguments: '"x"}' } }];
    const done = { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
    return sse(text, firstCall, secondCall, done);
  }});
  const events = [];
  for await (const event of provider.stream({ messages: [] })) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["text_delta", "tool_call_delta", "tool_call_delta", "finish"]);
  assert.equal(events[1].name, "lookup");
  assert.equal(events[2].arguments, '"x"}');
});

test("OpenAI-compatible provider flushes a final SSE row without a trailing newline", async () => {
  const payload = JSON.stringify({ choices: [{ delta: { content: "tail" }, finish_reason: "stop" }] });
  const provider = new OpenAICompatibleProvider({ model: "test", fetchImpl: async () => new Response(new TextEncoder().encode(`data: ${payload}`)) });
  const events = [];
  for await (const event of provider.stream({ messages: [] })) events.push(event);
  assert.deepEqual(events, [{ type: "text_delta", delta: "tail" }, { type: "finish", reason: "stop", usage: undefined }]);
});

test("turn loop executes tools, emits events, and retries stream failures", async () => {
  let attempts = 0;
  const bus = new EventBus();
  const seen = [];
  bus.on("text_delta", (event) => seen.push(event.delta));
  const provider = { async *stream({ messages }) {
    attempts++;
    if (attempts === 1) throw new Error("temporary");
    if (messages.at(-1)?.role === "tool") yield { type: "text_delta", delta: "done" };
    else {
      yield { type: "tool_call_delta", index: 0, id: "1", name: "echo", arguments: "{\"value\":1}" };
      yield { type: "finish", reason: "tool_calls" };
    }
  }};
  const result = await runTurn({ provider, messages: [{ role: "user", content: "go" }], executeTool: async (name, args) => `${name}:${args.value}`, bus, maxRetries: 1 });
  assert.equal(attempts, 3);
  assert.equal(result.message.content, "done");
  assert.deepEqual(seen, ["done"]);
  assert.equal(result.messages.at(-1).role, "assistant");
});

test("turn loop honors abort and max steps", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(() => runTurn({ provider: { stream: async function* () {} }, signal: controller.signal }), /stop/);
  const provider = { async *stream() { yield { type: "tool_call_delta", index: 0, id: "1", name: "again", arguments: "{}" }; } };
  await assert.rejects(() => runTurn({ provider, executeTool: async () => "ok", maxSteps: 1 }), /Maximum turn steps/);
});

test("JSONL sessions append, replay, and resume without rewriting history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandora-session-"));
  try {
    const path = join(dir, "session.jsonl");
    const store = new JsonlSessionStore(path);
    await store.appendMessage({ role: "user", content: "hello" });
    await store.appendMessage({ role: "assistant", content: "world" });
    assert.deepEqual(await store.resume(), [{ role: "user", content: "hello" }, { role: "assistant", content: "world" }]);
    const before = await readFile(path, "utf8");
    await store.append({ type: "event", value: 3, timestamp: "fixed" });
    const after = await readFile(path, "utf8");
    assert.equal(after.split("\n").filter(Boolean).length, 3);
    assert.ok(after.startsWith(before));
    assert.equal((await store.replay()).at(-1).payload.value, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("turn loop never retries after exposing a partial stream", async () => {
  let attempts = 0;
  const seen = [];
  const bus = new EventBus();
  bus.on("text_delta", event => seen.push(event.delta));
  const provider = { async *stream() {
    attempts += 1;
    yield { type: "text_delta", delta: "visible" };
    throw new Error("stream interrupted");
  } };
  await assert.rejects(() => runTurn({ provider, messages: [], bus, maxRetries: 3 }), /stream interrupted/);
  assert.equal(attempts, 1);
  assert.deepEqual(seen, ["visible"]);
});

test("turn loop rejects incomplete provider tool calls", async () => {
  const provider = { async *stream() { yield { type: "tool_call_delta", index: 0, id: "call", arguments: "{}" }; } };
  await assert.rejects(() => runTurn({ provider, messages: [], executeTool: async () => "no" }), /incomplete tool call/);
});

test("JSONL replay tolerates only an unterminated crash tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandora-session-tail-"));
  try {
    const path = join(dir, "session.jsonl");
    await writeFile(path, '{"type":"message","message":{"role":"user","content":"safe"}}\n{"type":"message"');
    assert.equal((await new JsonlSessionStore(path).resume()).length, 1);
    await appendFile(path, "\n");
    await assert.rejects(() => new JsonlSessionStore(path).replay(), /Invalid JSONL at line 2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider and turn loop normalize streamed usage", async () => {
  const usageChunk = { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } };
  const provider = new OpenAICompatibleProvider({ model: "usage", fetchImpl: async () => sse(usageChunk) });
  const result = await runTurn({ provider, messages: [] });
  assert.deepEqual(result.usage, { input: 12, output: 4, cacheRead: 3 });
});

test("provider errors include bounded response detail", async () => {
  const provider = new OpenAICompatibleProvider({ model: "error", fetchImpl: async () => new Response("invalid request", { status: 400 }) });
  await assert.rejects(() => runTurn({ provider, messages: [], maxRetries: 0 }), /Provider request failed \(400\): invalid request/);
});

test("JSONL store serializes concurrent append sequence numbers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandora-session-sequence-"));
  try {
    const store = new JsonlSessionStore(join(dir, "session.jsonl"));
    await Promise.all(Array.from({ length: 20 }, (_value, index) => store.append({ type: "event", index })));
    const events = await store.replay();
    assert.deepEqual(events.map(event => event.sequence), Array.from({ length: 20 }, (_value, index) => index + 1));
    assert.equal(new Set(events.map(event => event.payload.index)).size, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JSONL append quarantines a malformed crash tail before resuming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandora-session-repair-"));
  try {
    const path = join(dir, "session.jsonl");
    const safe = '{"schemaVersion":1,"type":"message","message":{"role":"user","content":"safe"},"sequence":1,"timestamp":"fixed"}\n';
    const malformed = '{"type":"message"';
    await writeFile(path, safe + malformed);
    const store = new JsonlSessionStore(path);
    const appended = await store.append({ type: "event", value: "recovered" });
    assert.equal(appended.sequence, 2);
    assert.equal(store.lastRecovery.type, "quarantined-malformed-tail");
    assert.equal(await readFile(store.lastRecovery.quarantinePath, "utf8"), malformed);
    assert.deepEqual((await store.replay()).map(event => event.type), ["user.message.accepted", "runtime.unknown"]);
    assert.equal((await readdir(dir)).filter(name => name.endsWith(".crash-tail")).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("JSONL append terminates a complete unterminated envelope without data loss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandora-session-terminate-"));
  try {
    const path = join(dir, "session.jsonl");
    await writeFile(path, '{"schemaVersion":1,"type":"event","sequence":4,"timestamp":"fixed"}');
    const store = new JsonlSessionStore(path);
    const appended = await store.append({ type: "event", value: "next" });
    assert.equal(appended.sequence, 5);
    assert.equal(store.lastRecovery.type, "terminated-complete-tail");
    assert.equal((await store.replay()).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
