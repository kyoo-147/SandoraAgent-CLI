import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const root = resolve(import.meta.dirname, "../..");
const entrypoint = resolve(root, "src/cli/headless-jsonl.mjs");
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(20);
  if (!predicate()) throw new Error(message);
}

async function providerServer({ hold = false } = {}) {
  let seen = false;
  let closed = false;
  const server = createServer((request, response) => {
    seen = true;
    request.on("close", () => { closed = true; });
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (hold) { response.write(": hold\n\n"); return; }
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "HEADLESS_OK" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  return { server, port: server.address().port, get seen() { return seen; }, get closed() { return closed; } };
}

async function startHeadless(cwd, port, extraEnv = {}) {
  const child = spawn(process.execPath, [entrypoint], { cwd, env: { ...process.env, SANDORA_AGENT_CORE: "native", OPENAI_MODEL: "fixture", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const messages = [];
  let stderr = "";
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => { try { messages.push(JSON.parse(line)); } catch { messages.push({ invalid: line }); } });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = new Promise((resolveExit, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolveExit({ code, signal })); });
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  await waitFor(() => messages.some(message => message.kind === "ready"), `headless transport did not become ready: ${stderr}`);
  return { child, messages, stderr: () => stderr, exit, send };
}

async function closeServer(server) {
  const closed = new Promise(resolveClose => server.close(resolveClose));
  server.closeAllConnections();
  await closed;
}

test("headless JSONL streams normalized events and a correlated final response", { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "sandora-headless-"));
  const provider = await providerServer();
  const client = await startHeadless(cwd, provider.port);
  try {
    client.child.stdin.write("\n");
    client.send({ id: "status-1", type: "status" });
    client.send({ id: "prompt-1", type: "prompt", text: "hello" });
    await waitFor(() => client.messages.some(message => message.kind === "response" && message.requestId === "prompt-1"), "prompt response missing");
    const response = client.messages.find(message => message.kind === "response" && message.requestId === "prompt-1");
    assert.equal(response.ok, true);
    assert.equal(response.result.status, "completed");
    assert.match(response.result.text, /HEADLESS_OK/);
    assert.ok(client.messages.some(message => message.kind === "event" && message.requestId === "prompt-1" && message.event.type === "text.delta"));
    assert.ok(client.messages.some(message => message.kind === "response" && message.requestId === "status-1" && message.result.runtime === "native"));
    client.send({ id: "status-1", type: "status" });
    await waitFor(() => client.messages.filter(message => message.requestId === "status-1").length === 2, "duplicate id response missing");
    assert.equal(client.messages.filter(message => message.requestId === "status-1")[1].error.code, "duplicate_request");
    assert.deepEqual(client.messages.map(message => message.sequence), client.messages.map(message => message.sequence).slice().sort((a, b) => a - b));
    client.send({ id: "shutdown-1", type: "shutdown" });
    assert.deepEqual(await client.exit, { code: 0, signal: null });
    assert.equal(provider.seen, true);
    assert.equal(client.messages.some(message => message.invalid), false);
  } finally {
    if (client.child.exitCode === null) client.child.kill();
    await closeServer(provider.server);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("headless JSONL rejects overlap, aborts the active run, and exits on shutdown", { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "sandora-headless-abort-"));
  const provider = await providerServer({ hold: true });
  const client = await startHeadless(cwd, provider.port);
  try {
    client.send({ id: "prompt-a", type: "prompt", text: "wait" });
    await waitFor(() => provider.seen, "held provider request did not start");
    client.send({ id: "prompt-b", type: "prompt", text: "overlap" });
    await waitFor(() => client.messages.some(message => message.requestId === "prompt-b"), "busy response missing");
    assert.equal(client.messages.find(message => message.requestId === "prompt-b").error.code, "busy");
    client.send({ id: "abort-a", type: "abort" });
    await waitFor(() => provider.closed, "provider request did not close after abort");
    await waitFor(() => client.messages.some(message => message.kind === "response" && message.requestId === "prompt-a"), "aborted prompt response missing");
    const aborted = client.messages.find(message => message.kind === "response" && message.requestId === "prompt-a");
    assert.equal(aborted.error.code, "aborted");
    client.send({ id: "shutdown-a", type: "shutdown" });
    assert.deepEqual(await client.exit, { code: 0, signal: null });
  } finally {
    if (client.child.exitCode === null) client.child.kill();
    await closeServer(provider.server);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("headless JSONL SIGINT aborts owned work and exits with interrupt status", { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "sandora-headless-sigint-"));
  const provider = await providerServer({ hold: true });
  const client = await startHeadless(cwd, provider.port);
  try {
    client.send({ id: "prompt-sigint", type: "prompt", text: "wait" });
    await waitFor(() => provider.seen, "held provider request did not start");
    client.child.kill("SIGINT");
    await waitFor(() => provider.closed, "provider request remained live after SIGINT");
    const exited = await client.exit;
    if (process.platform === "win32") assert.deepEqual(exited, { code: null, signal: "SIGINT" });
    else assert.deepEqual(exited, { code: 130, signal: null });
  } finally {
    if (client.child.exitCode === null) client.child.kill();
    await closeServer(provider.server);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("headless JSONL fails closed when its bounded output queue overflows", { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "sandora-headless-pressure-"));
  const provider = await providerServer();
  const client = await startHeadless(cwd, provider.port, { SANDORA_JSONL_MAX_OUTPUT_BYTES: "1024" });
  client.child.stdout.pause();
  try {
    for (let index = 0; index < 5_000; index += 1) client.send({ id: `status-${index}`, type: "status" });
    assert.deepEqual(await client.exit, { code: 4, signal: null });
  } finally {
    if (client.child.exitCode === null) client.child.kill();
    await closeServer(provider.server);
    await rm(cwd, { recursive: true, force: true });
  }
});
