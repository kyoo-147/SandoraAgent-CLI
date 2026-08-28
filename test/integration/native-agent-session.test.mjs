import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, providerFromEnvironment } from "../../src/runtime/native-agent-session.mjs";
import { createDelegateSubagentsTool } from "../../src/agents/subagents.mjs";
import { defineTool, NativeToolRegistry } from "../../src/tools/registry.mjs";
import { JsonlSessionStore } from "../../src/runtime/turn-runtime.mjs";

const text = result => result.content[0].text;

test("native session streams, executes tools, persists, and resumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-session-"));
  const sessionPath = join(root, "session.jsonl");
  let calls = 0;
  const provider = { model: "fixture", async *stream({ messages }) {
    calls += 1;
    if (messages.at(-1)?.role === "tool") yield { type: "text_delta", delta: `tool said ${messages.at(-1).content}` };
    else yield { type: "tool_call_delta", index: 0, id: "call-1", name: "echo", arguments: '{"value":"ok"}' };
  } };
  const registry = new NativeToolRegistry();
  registry.register(defineTool({ name: "echo", description: "echo", parameters: { type: "object" }, execute: async (_id, args) => ({ content: [{ type: "text", text: args.value }] }) }));
  const events = [];
  try {
    const session = await createAgentSession({ cwd: root, sessionPath, provider, registry, systemPrompt: "fixture system" });
    const firstSessionId = session.sessionId;
    session.subscribe(event => events.push(event.type));
    const result = await session.prompt("go");
    assert.equal(result.message.content, "tool said ok");
    assert.equal(calls, 2);
    assert.ok(events.includes("tool.start"));
    assert.ok(events.includes("tool.end"));
    assert.ok(events.includes("text.delta"));
    session.dispose();

    const persisted = await new JsonlSessionStore(sessionPath).resume();
    assert.deepEqual(persisted.map(message => message.role), ["user", "assistant", "tool", "assistant"]);
    const durable = await new JsonlSessionStore(sessionPath).replay();
    assert.deepEqual(durable.map(event => event.sequence), durable.map((_event, index) => index + 1));
    for (const type of ["session.started", "turn.started", "model.started", "tool.started", "tool.completed", "turn.completed"]) {
      assert.ok(durable.some(event => event.type === type), `missing durable ${type}`);
    }
    const resumedProvider = { model: "fixture", async *stream({ messages }) {
      assert.equal(messages[0].content, "fixture system");
      assert.equal(messages.filter(message => message.role === "system").length, 1);
      assert.equal(messages.filter(message => message.role === "user").length, 2);
      yield { type: "text_delta", delta: "resumed" };
    } };
    const resumed = await createAgentSession({ cwd: root, sessionPath, provider: resumedProvider, registry: new NativeToolRegistry(), systemPrompt: "fixture system" });
    assert.equal(resumed.sessionId, firstSessionId);
    assert.equal((await resumed.prompt("again")).message.content, "resumed");
    resumed.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native session retains completed tool turns across provider failure and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-failed-turn-"));
  const sessionPath = join(root, "session.jsonl");
  let sideEffects = 0;
  let attempts = 0;
  const registry = new NativeToolRegistry();
  registry.register(defineTool({ name: "mutate", description: "mutate", parameters: { type: "object" }, execute: async () => { sideEffects += 1; return { content: [{ type: "text", text: "mutation complete" }] }; } }));
  const failingProvider = { model: "fixture", async *stream({ messages }) {
    attempts += 1;
    if (messages.at(-1)?.role === "tool") {
      yield { type: "text_delta", delta: "partial answer" };
      throw new Error("forced provider failure");
    }
    yield { type: "tool_call_delta", index: 0, id: "mutate-call", name: "mutate", arguments: "{}" };
  } };
  try {
    const session = await createAgentSession({ cwd: root, sessionPath, provider: failingProvider, registry });
    await assert.rejects(session.prompt("change it"), /forced provider failure/);
    assert.equal(sideEffects, 1);
    const persisted = await new JsonlSessionStore(sessionPath).resume();
    assert.deepEqual(persisted.map(message => message.role), ["user", "assistant", "tool"]);
    assert.equal(persisted[1].tool_calls[0].function.name, "mutate");
    assert.equal(persisted[2].content, "mutation complete");
    const interrupted = (await new JsonlSessionStore(sessionPath).replay()).find(event => event.type === "assistant.partial");
    assert.deepEqual({ status: interrupted.status, content: interrupted.content, truncated: interrupted.truncated }, { status: "INTERRUPTED", content: "partial answer", truncated: false });
    session.dispose();

    const restarted = await createAgentSession({ cwd: root, sessionPath, provider: { model: "fixture", async *stream({ messages }) {
      assert.ok(messages.some(message => message.role === "tool"), "restarted context must retain the tool result");
      yield { type: "text_delta", delta: "recovered" };
    } }, registry: new NativeToolRegistry() });
    assert.equal((await restarted.prompt("continue")).message.content, "recovered");
    assert.equal(sideEffects, 1, "restart must not replay the completed side effect");
    assert.equal(attempts, 2);
    restarted.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native restart repairs an assistant tool call missing its durable result", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-incomplete-tool-"));
  const sessionPath = join(root, "session.jsonl");
  const store = new JsonlSessionStore(sessionPath);
  try {
    await store.append({ type: "session.started", sessionId: "recovery-session" });
    await store.append({ type: "turn.started", sessionId: "recovery-session", turnId: "interrupted" });
    await store.append({ type: "message", turnId: "interrupted", message: { role: "user", content: "change it" } });
    await store.append({ type: "message", turnId: "interrupted", message: { role: "assistant", content: null, tool_calls: [{ id: "missing-result", type: "function", function: { name: "mutate", arguments: "{}" } }] } });
    const provider = { model: "fixture", async *stream({ messages }) {
      const repaired = messages.find(message => message.role === "tool" && message.tool_call_id === "missing-result");
      assert.ok(repaired, "restart must provide a matching synthetic tool result");
      assert.match(repaired.content, /ambiguousExternalEffect/);
      yield { type: "text_delta", delta: "recovered safely" };
    } };
    const session = await createAgentSession({ cwd: root, sessionPath, provider, registry: new NativeToolRegistry() });
    assert.equal((await session.prompt("continue")).message.content, "recovered safely");
    session.dispose();
    const durable = await store.replay();
    assert.equal(durable.filter(event => event.type === "recovery.tool_result_synthesized").length, 1);
    const restarted = await createAgentSession({ cwd: root, sessionPath, provider: { model: "fixture", async *stream() { yield { type: "text_delta", delta: "again" }; } }, registry: new NativeToolRegistry() });
    restarted.dispose();
    assert.equal((await store.replay()).filter(event => event.type === "recovery.tool_result_synthesized").length, 1, "repair must be idempotent");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native session aborts an active provider stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-abort-"));
  const provider = { model: "fixture", async *stream({ signal }) {
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } };
  try {
    const session = await createAgentSession({ cwd: root, provider, registry: new NativeToolRegistry() });
    const pending = session.prompt("wait");
    await new Promise(resolve => setTimeout(resolve, 10));
    await session.abort();
    await assert.rejects(pending, /aborted/i);
    const durable = await new JsonlSessionStore(join(root, ".sandora", "session.jsonl")).replay();
    assert.ok(durable.some(event => event.type === "turn.cancel.requested"));
    assert.ok(durable.some(event => event.type === "turn.aborted"));
    session.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider configuration is explicit and supports keyless local endpoints", () => {
  assert.equal(providerFromEnvironment({}).model, "offline");
  assert.equal(providerFromEnvironment({ SANDORA_OFFLINE: "1", OPENAI_MODEL: "x" }).model, "offline");
  assert.equal(providerFromEnvironment({ OPENAI_MODEL: "local", OPENAI_BASE_URL: "http://127.0.0.1:1234/v1" }, async () => {}).model, "local");
});

test("native tool registry rejects collisions and normalizes delegation", async () => {
  const registry = new NativeToolRegistry();
  registry.register(defineTool({ name: "one", execute: async () => "one" }));
  assert.throws(() => registry.register(defineTool({ name: "one", execute: async () => "two" })), /already registered/);
  const provider = { model: "fixture", async *stream({ messages }) { yield { type: "text_delta", delta: `report:${messages.at(-1).content}` }; } };
  const delegate = createDelegateSubagentsTool({ provider, cwd: process.cwd(), maxConcurrency: 2 });
  const result = await delegate.execute("test", { tasks: ["alpha", "beta"] });
  assert.match(text(result), /WORKER 1 · completed/);
  assert.match(text(result), /report:alpha/);
  assert.match(text(result), /report:beta/);
  assert.equal(result.details.workerCount, 2);
});

test("native session emits normalized usage to the TUI contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-usage-"));
  const provider = { model: "fixture", async *stream() {
    yield { type: "text_delta", delta: "done" };
    yield { type: "usage", usage: { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } } };
  } };
  try {
    const session = await createAgentSession({ cwd: root, provider, registry: new NativeToolRegistry() });
    const events = [];
    session.subscribe(event => events.push(event));
    await session.prompt("usage");
    const ended = events.find(event => event.type === "message.end");
    assert.deepEqual(ended.usage, { input: 9, output: 2, cacheRead: 1, cost: 0 });
    session.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
