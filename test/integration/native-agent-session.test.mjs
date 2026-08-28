import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, providerFromEnvironment } from "../../src/runtime/native-agent-session.mjs";
import { createDelegateSubagentsTool } from "../../src/agents/subagents.mjs";
import { SandoraAgentManager } from "../../src/agents/manager.mjs";
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
    for (const type of ["session.created", "turn.requested", "turn.started", "model.request.requested", "model.request.started", "model.request.completed", "assistant.message.started", "assistant.delta", "tool.call.requested", "tool.call.started", "tool.call.completed", "turn.completed"]) {
      assert.ok(durable.some(event => event.type === type), `missing durable ${type}`);
    }
    assert.equal(durable.filter(event => event.type === "model.request.requested").length, 2);
    assert.equal(durable.filter(event => event.type === "model.request.completed").length, 2);
    assert.ok(durable.findIndex(event => event.type === "tool.call.requested") < durable.findIndex(event => event.type === "tool.call.started"));
    for (const event of durable.filter(event => /^(model\.request|model\.usage)/.test(event.type))) assert.equal(event.correlationId, event.payload.requestId);
    for (const event of durable.filter(event => /^assistant\./.test(event.type))) assert.equal(event.correlationId, event.payload.assistantMessageId);
    for (const event of durable.filter(event => /^tool\.call/.test(event.type))) assert.equal(event.correlationId, event.payload.toolCallId);
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

test("native restart rejects model or system-prompt identity drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-identity-")); const sessionPath = join(root, "session.jsonl");
  const provider = model => ({ model, async *stream() { yield { type: "text_delta", delta: "unused" }; } });
  try {
    const initial = await createAgentSession({ cwd: root, sessionPath, provider: provider("model-a"), registry: new NativeToolRegistry(), systemPrompt: "SYSTEM-A" }); initial.dispose();
    await assert.rejects(() => createAgentSession({ cwd: root, sessionPath, provider: provider("model-b"), registry: new NativeToolRegistry(), systemPrompt: "SYSTEM-A" }), /identity does not match/);
    await assert.rejects(() => createAgentSession({ cwd: root, sessionPath, provider: provider("model-a"), registry: new NativeToolRegistry(), systemPrompt: "SYSTEM-B" }), /identity does not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
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
    const interrupted = (await new JsonlSessionStore(sessionPath).replay()).find(event => event.type === "assistant.message.interrupted");
    assert.deepEqual({ status: interrupted.payload.status, content: interrupted.payload.content, truncated: interrupted.payload.truncated }, { status: "INTERRUPTED", content: "partial answer", truncated: false });
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
    assert.ok(durable.some(event => event.type === "turn.cancelled"));
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
  const root = await mkdtemp(join(tmpdir(), "sandora-native-delegation-"));
  try {
    const registry = new NativeToolRegistry();
    registry.register(defineTool({ name: "one", execute: async () => "one" }));
    assert.throws(() => registry.register(defineTool({ name: "one", execute: async () => "two" })), /already registered/);
    const provider = { model: "fixture", async *stream({ messages }) { yield { type: "text_delta", delta: `report:${messages.at(-1).content}` }; } };
    const delegate = createDelegateSubagentsTool({ provider, cwd: root, maxConcurrency: 2 });
    const result = await delegate.execute("test", { tasks: ["alpha", "beta"] });
    assert.match(text(result), /WORKER 1 · completed/);
    assert.match(text(result), /report:alpha/);
    assert.match(text(result), /report:beta/);
    assert.equal(result.details.workerCount, 2);
    const restored = new SandoraAgentManager({ runStoreRoot: join(root, ".sandora", "tasks", "runs"), runner: async () => { throw new Error("must not replay"); } });
    assert.equal((await restored.restore(result.details.runId)).tasks.every(task => task.status === "completed"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
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
    const durableUsage = (await new JsonlSessionStore(join(root, ".sandora", "session.jsonl")).replay()).find(event => event.type === "model.usage");
    assert.deepEqual(durableUsage.payload.usage, { input: 9, output: 2, cacheRead: 1 });
    session.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native lifecycle persists bounded unicode deltas and model failure ordering", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-lifecycle-failure-"));
  const content = "🙂".repeat(6000);
  const provider = { model: "fixture", async *stream() { yield { type: "text_delta", delta: content }; throw new Error("stream failed"); } };
  try {
    const session = await createAgentSession({ cwd: root, provider, registry: new NativeToolRegistry(), maxSteps: 1 });
    await assert.rejects(session.prompt("fail after text"), /stream failed/);
    const durable = await new JsonlSessionStore(join(root, ".sandora", "session.jsonl")).replay();
    const deltas = durable.filter(event => event.type === "assistant.delta");
    assert.equal(durable.filter(event => event.type === "assistant.message.started").length, 1);
    assert.equal(deltas.map(event => event.payload.delta).join(""), content);
    assert.equal(deltas.every(event => Buffer.byteLength(event.payload.delta) <= 4096), true);
    const interrupted = durable.find(event => event.type === "assistant.message.interrupted");
    assert.equal(interrupted.payload.truncated, true);
    assert.equal(interrupted.payload.contentBytes, Buffer.byteLength(interrupted.payload.content));
    assert.ok(interrupted.payload.contentBytes <= 20_000);
    assert.ok(durable.findIndex(event => event.type === "model.request.failed") < durable.findIndex(event => event.type === "turn.failed"));
    assert.equal(durable.some(event => event.type === "model.request.completed"), false);
    session.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native explicit close is durable and idempotent without claiming crash closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-close-"));
  try {
    const session = await createAgentSession({ cwd: root, provider: { model: "fixture", async *stream() { yield { type: "text_delta", delta: "done" }; } }, registry: new NativeToolRegistry() });
    await session.close(); await session.close();
    await assert.rejects(() => session.prompt("after close"), /closed/);
    const durable = await new JsonlSessionStore(join(root, ".sandora", "session.jsonl")).replay();
    assert.equal(durable.filter(event => event.type === "session.closed").length, 1);
    await assert.rejects(() => createAgentSession({ cwd: root, provider: { model: "fixture", async *stream() {} }, registry: new NativeToolRegistry() }), /closed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native close settles active cancellation before durable session closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-active-close-"));
  let streamStarted;
  const started = new Promise(resolve => { streamStarted = resolve; });
  const provider = { model: "fixture", async *stream({ signal }) { streamStarted(); await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } };
  try {
    const session = await createAgentSession({ cwd: root, provider, registry: new NativeToolRegistry() });
    const pending = session.prompt("wait"); const rejected = assert.rejects(pending, /closed/i); await started;
    await session.close(); await rejected;
    const durable = await new JsonlSessionStore(join(root, ".sandora", "session.jsonl")).replay();
    const cancelled = durable.findIndex(event => event.type === "turn.cancelled");
    const closed = durable.findIndex(event => event.type === "session.closed");
    assert.ok(cancelled >= 0 && cancelled < closed);
    assert.equal(durable.filter(event => event.type === "turn.cancel.requested").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native abort classifies an in-flight tool as cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-tool-cancel-"));
  let toolStarted;
  const started = new Promise(resolve => { toolStarted = resolve; });
  const registry = new NativeToolRegistry();
  registry.register({ name: "wait", async execute(_id, _args, signal) { toolStarted(); await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } });
  const provider = { model: "fixture", async *stream() { yield { type: "tool_call_delta", index: 0, id: "cancel-tool", name: "wait", arguments: "{}" }; } };
  try {
    const session = await createAgentSession({ cwd: root, provider, registry });
    const pending = session.prompt("cancel tool"); const rejected = assert.rejects(pending, /aborted/i); await started;
    await session.abort(); await rejected;
    const durable = await new JsonlSessionStore(join(root, ".sandora", "session.jsonl")).replay();
    assert.equal(durable.filter(event => event.type === "tool.call.cancelled" && event.payload.toolCallId === "cancel-tool").length, 1);
    assert.equal(durable.some(event => event.type === "tool.call.failed" && event.payload.toolCallId === "cancel-tool"), false);
    session.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native restart classifies incomplete lifecycle boundaries exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-lifecycle-repair-"));
  const sessionPath = join(root, "session.jsonl");
  const store = new JsonlSessionStore(sessionPath);
  try {
    await store.append({ type: "session.created", sessionId: "repair", runtime: "sandora-native", model: "fixture" });
    await store.append({ type: "model.request.requested", correlationId: "request-intent", sessionId: "repair", turnId: "turn-open", requestId: "request-intent", step: 0, attempt: 0 });
    await store.append({ type: "model.request.started", correlationId: "request-open", sessionId: "repair", turnId: "turn-open", requestId: "request-open", step: 0, attempt: 0 });
    await store.append({ type: "assistant.message.started", correlationId: "assistant-open", sessionId: "repair", turnId: "turn-open", requestId: "request-open", assistantMessageId: "assistant-open", step: 0 });
    await store.append({ type: "tool.call.started", correlationId: "tool-open", sessionId: "repair", turnId: "turn-open", toolCallId: "tool-open", toolExecutionId: "execution-open", name: "mutate", step: 0 });
    await store.append({ type: "tool.call.requested", correlationId: "tool-intent", sessionId: "repair", turnId: "turn-open", requestId: "request-open", assistantMessageId: "assistant-open", toolCallId: "tool-intent", name: "mutate", step: 0 });
    const create = () => createAgentSession({ cwd: root, sessionPath, provider: { model: "fixture", async *stream() { yield { type: "text_delta", delta: "unused" }; } }, registry: new NativeToolRegistry() });
    const first = await create(); first.dispose();
    const second = await create(); second.dispose();
    const durable = await store.replay();
    assert.equal(durable.filter(event => event.type === "model.request.unknown" && event.payload.requestId === "request-open").length, 1);
    assert.equal(durable.filter(event => event.type === "model.request.unknown" && event.payload.requestId === "request-intent").length, 1);
    assert.equal(durable.filter(event => event.type === "tool.call.unknown" && event.payload.toolCallId === "tool-open").length, 1);
    assert.equal(durable.filter(event => event.type === "tool.call.unknown" && event.payload.toolCallId === "tool-intent").length, 1);
    assert.equal(durable.filter(event => event.type === "assistant.message.interrupted" && event.payload.assistantMessageId === "assistant-open").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
