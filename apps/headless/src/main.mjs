import process from "node:process";
import { createInterface } from "node:readline";
import { JSONL_PROTOCOL, JSONL_VERSION } from "@sandora/protocol";
export { JSONL_PROTOCOL, JSONL_VERSION };

export async function runHeadless({ createSession, customTools = [], approvals, cwd = process.cwd() } = {}) {
if (typeof createSession !== "function") throw new TypeError("createSession is required");
if (!approvals || typeof approvals.create !== "function" || typeof approvals.list !== "function") throw new TypeError("an approval store is required");

const MAX_INPUT_LINE_BYTES = 1024 * 1024;
const configuredOutputLimit = Number(process.env.SANDORA_JSONL_MAX_OUTPUT_BYTES || 4 * 1024 * 1024);
const MAX_QUEUED_OUTPUT_BYTES = Number.isSafeInteger(configuredOutputLimit) && configuredOutputLimit >= 1024 ? configuredOutputLimit : 4 * 1024 * 1024;

const systemPrompt = [
  "You are Sandora Agent, an autonomous coding and research agent.",
  "Inspect evidence, make bounded workspace changes, run relevant verification, diagnose recoverable failures, and report verified results honestly.",
  "Preserve unrelated work, never expose credentials, review diffs before delivery, and use explicit runtime authority for integration or merge operations.",
].join(" ");

let session;
let input;
let active = null;
let sequence = 0;
let shuttingDown = false;
let outputTail = Promise.resolve();
let queuedOutputBytes = 0;
const seenRequestIds = new Set();

function normalizedId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new Error("request id must be a non-empty string up to 128 characters");
  return value;
}

function serializable(value) {
  try { JSON.stringify(value); return value; }
  catch { return { type: "serialization.error", error: "Event payload was not JSON-serializable" }; }
}

function writeLine(envelope) {
  const line = `${JSON.stringify({ protocol: JSONL_PROTOCOL, version: JSONL_VERSION, sequence: ++sequence, ...envelope })}\n`;
  const bytes = Buffer.byteLength(line);
  if (queuedOutputBytes + bytes > MAX_QUEUED_OUTPUT_BYTES) {
    const error = Object.assign(new Error("JSONL output backpressure limit exceeded"), { code: "OUTPUT_BACKPRESSURE" });
    shuttingDown = true;
    process.exitCode = 4;
    input?.close();
    if (active) { active.abortRequested = true; void session?.abort(); }
    return Promise.reject(error);
  }
  queuedOutputBytes += bytes;
  const operation = outputTail.then(() => new Promise((resolveWrite, reject) => {
    const onError = error => { process.stdout.off("error", onError); reject(error); };
    process.stdout.once("error", onError);
    const done = () => { process.stdout.off("error", onError); resolveWrite(); };
    if (process.stdout.write(line)) done(); else process.stdout.once("drain", done);
  }));
  const settled = operation.finally(() => { queuedOutputBytes -= bytes; });
  outputTail = settled.catch(() => {});
  return settled;
}

function awaitOutputDrain(timeoutMs = 2_000) {
  return new Promise(resolveDrain => {
    const timer = setTimeout(() => resolveDrain(false), timeoutMs);
    timer.unref?.();
    outputTail.then(() => { clearTimeout(timer); resolveDrain(true); });
  });
}

const respond = (requestId, ok, result = undefined, error = undefined) => writeLine({ kind: "response", requestId, ok, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) });
const emitEvent = event => writeLine({ kind: "event", requestId: active?.id || null, event: serializable(event) });

async function handlePrompt(message) {
  const id = normalizedId(message.id);
  if (active) return respond(id, false, undefined, { code: "busy", message: `request ${active.id} is still active` });
  if (typeof message.text !== "string" || !message.text.trim()) return respond(id, false, undefined, { code: "invalid_prompt", message: "prompt text is required" });
  let resolveDone;
  const done = new Promise(resolveActive => { resolveDone = resolveActive; });
  active = { id, abortRequested: false, done, resolveDone };
  await writeLine({ kind: "accepted", requestId: id, operation: "prompt" });
  try {
    await session.prompt(message.text);
    await outputTail;
    const aborted = active?.abortRequested === true;
    await respond(id, true, { status: aborted ? "aborted" : "completed", text: session.getLastAssistantText?.() || "", contextUsage: session.getContextUsage?.() || null });
  } catch (error) {
    const aborted = active?.abortRequested === true;
    await respond(id, false, undefined, { code: aborted ? "aborted" : "prompt_failed", message: aborted ? "Prompt aborted" : error instanceof Error ? error.message : String(error) });
  } finally {
    active?.resolveDone();
    active = null;
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return respond(null, false, undefined, { code: "invalid_request", message: "request must be a JSON object" });
  const id = normalizedId(message.id);
  if (seenRequestIds.has(id)) return respond(id, false, undefined, { code: "duplicate_request", message: "request id has already been used" });
  seenRequestIds.add(id);
  if (message.type === "prompt") return handlePrompt(message);
  if (message.type === "abort") {
    if (!active) return respond(id, true, { status: "idle" });
    active.abortRequested = true;
    await session.abort();
    return respond(id, true, { status: "abort_requested", activeRequestId: active.id });
  }
  if (message.type === "history") return respond(id, true, { messages: session.getDisplayMessages?.() || [] });
  if (message.type === "status") return respond(id, true, { runtime: session.runtime, sessionId: session.sessionId, model: session.model?.id || null, thinkingLevel: session.thinkingLevel || null, activeRequestId: active?.id || null, contextUsage: session.getContextUsage?.() || null });
  if (message.type === "approval_create") return respond(id, true, { approval: await approvals.create(message) });
  if (message.type === "approval_list") return respond(id, true, { approvals: await approvals.list() });
  if (message.type === "shutdown") {
    shuttingDown = true;
    const running = active;
    if (running) { running.abortRequested = true; await session.abort(); await running.done; }
    await respond(id, true, { status: "shutting_down" });
    input?.close();
    return;
  }
  return respond(id, false, undefined, { code: "unsupported_type", message: `unsupported request type: ${message.type || "missing"}` });
}

try {
  session = await createSession({ cwd, customTools, systemPrompt });
  session.subscribe(event => { void emitEvent(event).catch(error => { process.stderr.write(`headless event output failed: ${error.message}\n`); process.exitCode = 4; void session.abort(); }); });
  await writeLine({ kind: "ready", requestId: null, result: { runtime: session.runtime, sessionId: session.sessionId, model: session.model?.id || null, thinkingLevel: session.thinkingLevel || null, cwd } });
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.once("SIGINT", () => { shuttingDown = true; process.exitCode = 130; if (active) { active.abortRequested = true; void session.abort(); } input?.close(); });
  input.on("line", line => {
    if (shuttingDown) return;
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_INPUT_LINE_BYTES) { void respond(null, false, undefined, { code: "line_too_large", message: "input line exceeds 1 MiB" }); return; }
    let message;
    try { message = JSON.parse(line); }
    catch { void respond(null, false, undefined, { code: "invalid_json", message: "input line is not valid JSON" }); return; }
    void handleMessage(message).catch(error => { if (error?.code !== "OUTPUT_BACKPRESSURE") void respond(message?.id || null, false, undefined, { code: "internal_error", message: error instanceof Error ? error.message : String(error) }).catch(() => {}); });
  });
  await new Promise(resolveClose => input.once("close", resolveClose));
  if (active) { const running = active; running.abortRequested = true; await session.abort(); await running.done; }
  const drained = await awaitOutputDrain();
  if (!drained) { process.exitCode = process.exitCode || 4; process.stdout.destroy(); }
} catch (error) {
  try { await writeLine({ kind: "fatal", requestId: null, error: { code: "startup_failed", message: error instanceof Error ? error.message : String(error) } }); await outputTail; }
  catch { process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`); }
  process.exitCode = 1;
} finally {
  await session?.dispose();
}
}
