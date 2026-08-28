import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const entrypoint = resolve(root, "start.mjs");
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const visible = output => output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(25);
  if (!predicate()) throw new Error(message);
}

async function fixtureServer({ hold = false } = {}) {
  let requestSeen = false;
  let requestClosed = false;
  const server = createServer((request, response) => {
    requestSeen = true;
    request.on("close", () => { requestClosed = true; });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (hold) { response.write(": waiting\n\n"); return; }
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "CLI_FLOW_OK" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  return { server, port: server.address().port, get requestSeen() { return requestSeen; }, get requestClosed() { return requestClosed; } };
}

async function startCli(cwd, port) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd,
    env: { ...process.env, SANDORA_AGENT_CORE: "native", OPENAI_MODEL: "fixture", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exit = new Promise((resolveExit, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolveExit({ code, signal })); });
  return { child, exit, output: () => visible(output) };
}

async function closeServer(server) {
  const closed = new Promise(resolveClose => server.close(resolveClose));
  server.closeAllConnections();
  await closed;
}

test("CLI streams a real local provider response from an arbitrary workspace and exits cleanly", { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "sandora-cli-flow-"));
  const fixture = await fixtureServer();
  const cli = await startCli(cwd, fixture.port);
  try {
    await delay(1_000);
    cli.child.stdin.write("hello\n");
    await waitFor(() => cli.output().includes("CLI_FLOW_OK"), "CLI did not render provider response");
    await delay(250);
    cli.child.stdin.write("/quit\n");
    assert.deepEqual(await cli.exit, { code: 0, signal: null });
    assert.equal(fixture.requestSeen, true);
  } finally {
    if (cli.child.exitCode === null) cli.child.kill();
    await closeServer(fixture.server);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("CLI Ctrl+C aborts an active provider request without exiting", { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "sandora-cli-abort-"));
  const fixture = await fixtureServer({ hold: true });
  const cli = await startCli(cwd, fixture.port);
  try {
    await delay(1_000);
    cli.child.stdin.write("wait\n");
    await waitFor(() => fixture.requestSeen, "provider request did not start");
    cli.child.stdin.write("\u0003");
    await waitFor(() => cli.output().includes("ABORTING"), "CLI did not expose ABORTING state");
    await waitFor(() => fixture.requestClosed, "provider request did not close after abort");
    assert.equal(cli.child.exitCode, null);
    await delay(100);
    cli.child.stdin.write("/status\n");
    await waitFor(() => cli.output().includes("Runtime: native"), "CLI was not usable after cancellation");
    cli.child.stdin.write("/quit\n");
    assert.deepEqual(await cli.exit, { code: 0, signal: null });
  } finally {
    if (cli.child.exitCode === null) cli.child.kill();
    await closeServer(fixture.server);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("CLI /quit during streaming aborts the provider and exits cleanly", { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "sandora-cli-quit-stream-"));
  const fixture = await fixtureServer({ hold: true });
  const cli = await startCli(cwd, fixture.port);
  try {
    await delay(1_000);
    cli.child.stdin.write("wait\n");
    await waitFor(() => fixture.requestSeen, "provider request did not start");
    cli.child.stdin.write("/quit\n");
    assert.deepEqual(await cli.exit, { code: 0, signal: null });
    assert.equal(fixture.requestClosed, true);
  } finally {
    if (cli.child.exitCode === null) cli.child.kill();
    await closeServer(fixture.server);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("CLI hydrates the visible conversation after native session restart", { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "sandora-cli-resume-"));
  const fixture = await fixtureServer();
  let first;
  let resumed;
  try {
    first = await startCli(cwd, fixture.port);
    await delay(800);
    first.child.stdin.write("remember this turn\n");
    await waitFor(() => first.output().includes("CLI_FLOW_OK"), "first CLI did not complete persisted turn");
    first.child.stdin.write("/quit\n");
    assert.deepEqual(await first.exit, { code: 0, signal: null });

    resumed = await startCli(cwd, fixture.port);
    await waitFor(() => resumed.output().includes("remember this turn") && resumed.output().includes("CLI_FLOW_OK"), "resumed CLI did not hydrate persisted conversation");
    resumed.child.stdin.write("/quit\n");
    assert.deepEqual(await resumed.exit, { code: 0, signal: null });
  } finally {
    if (first?.child.exitCode === null) first.child.kill();
    if (resumed?.child.exitCode === null) resumed.child.kill();
    await closeServer(fixture.server);
    await rm(cwd, { recursive: true, force: true });
  }
});
