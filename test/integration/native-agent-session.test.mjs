import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
    for (const type of ["session.created", "turn.requested", "turn.started", "model.request.requested", "model.request.started", "model.request.completed", "assistant.message.started", "assistant.delta", "tool.call.requested", "policy.decision", "tool.call.approved", "tool.call.started", "tool.call.completed", "turn.completed"]) {
      assert.ok(durable.some(event => event.type === type), `missing durable ${type}`);
    }
    assert.equal(durable.filter(event => event.type === "model.request.requested").length, 2);
    assert.equal(durable.filter(event => event.type === "model.request.completed").length, 2);
    assert.ok(durable.findIndex(event => event.type === "tool.call.requested") < durable.findIndex(event => event.type === "tool.call.started"));
    assert.ok(durable.findIndex(event => event.type === "policy.decision") < durable.findIndex(event => event.type === "tool.call.started"));
    assert.ok(durable.findIndex(event => event.type === "tool.call.approved") < durable.findIndex(event => event.type === "tool.call.started"));
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

test("native session delegates through a durable process worker and binds adapter bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-process-worker-"));
  const sessionPath = join(root, "session.jsonl");
  const adapterPath = join(root, "worker-adapter.mjs");
  const adapterSource = 'export async function run(request) { return `child:${request.prompt}`; }\n';
  await writeFile(adapterPath, adapterSource, "utf8");
  let calls = 0;
  const provider = { model: "fixture", async *stream({ messages }) {
    calls += 1;
    if (messages.at(-1)?.role === "tool") yield { type: "text_delta", delta: messages.at(-1).content };
    else yield { type: "tool_call_delta", index: 0, id: `delegate-call-${calls}`, name: "delegate_subagents", arguments: '{"tasks":["inspect one","inspect two"]}' };
  } };
  try {
    const session = await createAgentSession({ cwd: root, sessionPath, provider, registry: new NativeToolRegistry(), processMode: true, workerAdapter: "worker-adapter.mjs" });
    const result = await session.prompt("delegate");
    assert.match(result.message.content, /WORKER 1 · completed[\s\S]*child:inspect one/);
    assert.match(result.message.content, /WORKER 2 · completed[\s\S]*child:inspect two/);
    assert.equal(calls, 2);
    await writeFile(adapterPath, 'export async function run(request) { return `changed:${request.prompt}`; }\n', "utf8");
    const changed = await session.prompt("delegate after adapter change");
    assert.match(changed.message.content, /failed[\s\S]*worker adapter changed after session creation/);
    await writeFile(adapterPath, adapterSource, "utf8");
    session.dispose();

    const durable = await new JsonlSessionStore(sessionPath).replay();
    const created = durable.find(event => event.type === "session.created");
    assert.equal(created.payload.workerMode, "process");
    assert.match(created.payload.workerAdapterSha256, /^[a-f0-9]{64}$/);
    assert.match(created.payload.workerAdapterPathSha256, /^[a-f0-9]{64}$/);
    const runFiles = await readdir(join(root, ".sandora", "tasks", "runs"));
    assert.equal(runFiles.length, 2);
    const records = (await Promise.all(runFiles.map(async file => (await readFile(join(root, ".sandora", "tasks", "runs", file), "utf8")).trim().split("\n").map(JSON.parse)))).flat();
    const terminalProcesses = records.filter(record => record.type === "event" && record.patch?.process?.childExitVerified);
    assert.equal(terminalProcesses.length, 2);
    assert.ok(terminalProcesses.every(record => record.patch.process.processTreeCleanupVerified === false));

    const resumed = await createAgentSession({ cwd: root, sessionPath, provider: { model: "fixture", async *stream() { yield { type: "text_delta", delta: "resumed" }; } }, registry: new NativeToolRegistry(), processMode: true, workerAdapter: "worker-adapter.mjs" });
    resumed.dispose();
    await writeFile(adapterPath, 'export async function run(request) { return `changed:${request.prompt}`; }\n', "utf8");
    await assert.rejects(() => createAgentSession({ cwd: root, sessionPath, provider: { model: "fixture", async *stream() {} }, registry: new NativeToolRegistry(), processMode: true, workerAdapter: "worker-adapter.mjs" }), /identity does not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native schema denial is durable and prevents receipt claims and effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-schema-denial-")); let effects = 0;
  const registry = new NativeToolRegistry();
  registry.register(defineTool({ name: "typed", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, execute: async () => { effects += 1; return "unexpected"; } }));
  const provider = { model: "fixture", async *stream() { yield { type: "tool_call_delta", index: 0, id: "invalid-call", name: "typed", arguments: "{\"path\":7,\"extra\":true}" }; } };
  try {
    const session = await createAgentSession({ cwd: root, provider, registry });
    await assert.rejects(session.prompt("invalid tool"), /Invalid arguments/);
    assert.equal(effects, 0);
    const durable = await new JsonlSessionStore(join(root, ".sandora", "session.jsonl")).replay();
    const policy = durable.find(event => event.type === "policy.decision" && event.payload.toolCallId === "invalid-call");
    assert.equal(policy.payload.decision, "DENY"); assert.equal(policy.payload.reason, "INVALID_ARGUMENTS");
    assert.match(policy.payload.inputSha256, /^[a-f0-9]{64}$/);
    assert.ok(durable.some(event => event.type === "tool.call.denied" && event.payload.toolCallId === "invalid-call"));
    assert.equal(durable.some(event => event.type === "tool.call.started" && event.payload.toolCallId === "invalid-call"), false);
    session.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native approval denial is terminal before tool execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-approval-denial-")); let effects = 0;
  const previous = process.env.SANDORA_REQUIRE_APPROVALS; process.env.SANDORA_REQUIRE_APPROVALS = "1";
  const registry = new NativeToolRegistry(); registry.register(defineTool({ name: "git_merge", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { effects += 1; } }));
  const provider = { model: "fixture", async *stream() { yield { type: "tool_call_delta", index: 0, id: "denied-call", name: "git_merge", arguments: "{}" }; } };
  try {
    const session = await createAgentSession({ cwd: root, provider, registry });
    await assert.rejects(session.prompt("denied tool"), /approval missing/i);
    assert.equal(effects, 0);
    const durable = await new JsonlSessionStore(join(root, ".sandora", "session.jsonl")).replay();
    assert.ok(durable.some(event => event.type === "policy.decision" && event.payload.toolCallId === "denied-call" && event.payload.decision === "DENY" && event.payload.stage === "APPROVAL_GATE"));
    assert.ok(durable.some(event => event.type === "tool.call.denied" && event.payload.toolCallId === "denied-call"));
    assert.equal(durable.some(event => event.type === "tool.call.started" && event.payload.toolCallId === "denied-call"), false);
    session.dispose();
  } finally { if (previous === undefined) delete process.env.SANDORA_REQUIRE_APPROVALS; else process.env.SANDORA_REQUIRE_APPROVALS = previous; await rm(root, { recursive: true, force: true }); }
});

test("native restart rejects model or system-prompt identity drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-identity-")); const sessionPath = join(root, "session.jsonl");
  const provider = model => ({ model, async *stream() { yield { type: "text_delta", delta: "unused" }; } });
  try {
    const initial = await createAgentSession({ cwd: root, sessionPath, provider: provider("model-a"), registry: new NativeToolRegistry(), systemPrompt: "SYSTEM-A" }); initial.dispose();
    await assert.rejects(() => createAgentSession({ cwd: root, sessionPath, provider: provider("model-b"), registry: new NativeToolRegistry(), systemPrompt: "SYSTEM-A" }), /identity does not match/);
    await assert.rejects(() => createAgentSession({ cwd: root, sessionPath, provider: provider("model-a"), registry: new NativeToolRegistry(), systemPrompt: "SYSTEM-B" }), /identity does not match/);
    const configured = await createAgentSession({ cwd: root, sessionPath, provider: provider("model-a"), registry: new NativeToolRegistry(), systemPrompt: "SYSTEM-A", maxContextBytes: 1000, contextReserveBytes: 100 }); configured.dispose();
    await assert.rejects(() => createAgentSession({ cwd: root, sessionPath, provider: provider("model-a"), registry: new NativeToolRegistry(), systemPrompt: "SYSTEM-A", maxContextBytes: 2000, contextReserveBytes: 100 }), /identity does not match/);
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

test("native context compaction is durable and restart-equivalent", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-native-compaction-"));
  const sessionPath = join(root, "session.jsonl"); const requests = [];
  const provider = { model: "fixture", async *stream({ messages }) { requests.push(JSON.stringify(messages)); yield { type: "text_delta", delta: "ok" }; } };
  try {
    const session = await createAgentSession({ cwd: root, sessionPath, provider, registry: new NativeToolRegistry(), systemPrompt: "system", maxContextBytes: 300 });
    await session.prompt("a".repeat(200)); await session.prompt("b".repeat(200));
    assert.ok(session.getDisplayMessages().some(message => message.text.includes("a".repeat(100))), "full audit/display history must survive model-context compaction");
    session.dispose();
    const durable = await new JsonlSessionStore(sessionPath).replay();
    const compacted = durable.find(event => event.type === "context.compacted");
    assert.ok(compacted); assert.equal(compacted.payload.algorithm, "native-context/v1");
    assert.equal(compacted.payload.sourceMessageCount, compacted.payload.before.messages);
    assert.match(compacted.payload.contextSha256, /^[a-f0-9]{64}$/);
    assert.ok(durable.indexOf(compacted) < durable.findIndex((event, index) => index > durable.indexOf(compacted) && event.type === "model.request.requested"), "compaction must be durable before provider intent");
    const restarted = await createAgentSession({ cwd: root, sessionPath, provider, registry: new NativeToolRegistry(), systemPrompt: "system", maxContextBytes: 300 });
    await restarted.prompt("c"); restarted.dispose();
    assert.doesNotMatch(requests[2], /a{100}/, "restart must not resurrect dropped context");
  } finally { await rm(root, { recursive: true, force: true }); }
});
