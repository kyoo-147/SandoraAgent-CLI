import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, providerFromEnvironment } from "../src/native-agent-session.mjs";
import { createDelegateSubagentsTool } from "../src/subagents.mjs";
import { defineTool, NativeToolRegistry } from "../src/tool-registry.mjs";
import { JsonlSessionStore } from "../src/runtime.mjs";

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
