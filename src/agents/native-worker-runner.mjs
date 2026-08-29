import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL = "sandora-worker";
const MAX_LINE_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const normalizeCwd = value => /^[\\/]?[A-Za-z]:[\\/]/.test(value) ? value.replace(/^\/(?=[A-Za-z]:)/, "") : value;
const id = (value, name) => { if (typeof value !== "string" || !idPattern.test(value)) throw new Error(`invalid ${name}`); return value; };
const byteLength = value => Buffer.byteLength(String(value), "utf8");
const sha256 = value => createHash("sha256").update(value).digest("hex");

function workerEnvironment(env = process.env) {
  const allowed = ["SystemRoot", "WINDIR", "TEMP", "TMP"];
  return Object.fromEntries(allowed.filter(key => typeof env[key] === "string").map(key => [key, env[key]]));
}
function processEvidence(child, script, spawnedAt, patch = {}) {
  return { pid: child.pid, spawnedAt, entrypoint: script, childExitVerified: false, processTreeCleanupVerified: false, ...patch };
}
function processError(message, process) { return process === undefined ? new Error(message) : Object.assign(new Error(message), { process }); }

export async function resolveWorkerAdapterDescriptor(cwd, workerAdapter) {
  if (!cwd) throw new TypeError("cwd is required");
  if (typeof workerAdapter !== "string" || !workerAdapter) throw new TypeError("workerAdapter must be an explicit trusted module path");
  const workspaceRoot = await realpath(resolve(normalizeCwd(cwd)));
  const modulePath = await realpath(resolve(workspaceRoot, workerAdapter));
  const relation = relative(workspaceRoot, modulePath);
  if (!relation || relation.startsWith("..") || isAbsolute(relation) || !(await stat(modulePath)).isFile()) throw new Error("adapter must be a regular file inside workspace");
  const bytes = await readFile(modulePath);
  return Object.freeze({ workspaceRoot, modulePath, adapterModule: relation.replaceAll("\\", "/"), adapterContentSha256: sha256(bytes), adapterPathSha256: sha256(modulePath) });
}

/**
 * Spawn the fixed, trusted-local worker adapter entrypoint with strict JSONL stdout.
 * This verifies the direct child exit only; it is not an OS sandbox and does not
 * claim descendant process-tree cleanup.
 */
export function createNativeWorkerRunner({ cwd, workerAdapter, expectedAdapter, nodePath = process.execPath, timeoutMs = 120_000, killGraceMs = 250, maxLineBytes = MAX_LINE_BYTES, maxStderrBytes = MAX_STDERR_BYTES } = {}) {
  if (!cwd) throw new TypeError("cwd is required");
  if (typeof workerAdapter !== "string" || !workerAdapter) throw new TypeError("workerAdapter must be an explicit trusted module path");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(killGraceMs) || killGraceMs < 1) throw new TypeError("worker timeout and kill grace must be positive integers");
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > MAX_LINE_BYTES || !Number.isSafeInteger(maxStderrBytes) || maxStderrBytes < 1 || maxStderrBytes > MAX_STDERR_BYTES) throw new TypeError("worker output limits must be positive safe integers within protocol caps");
  if (expectedAdapter !== undefined && (!expectedAdapter || !/^[a-f0-9]{64}$/.test(expectedAdapter.adapterContentSha256 || "") || !/^[a-f0-9]{64}$/.test(expectedAdapter.adapterPathSha256 || ""))) throw new TypeError("expectedAdapter must contain valid content and path digests");
  const script = resolve(fileURLToPath(new URL("../../scripts/native-worker.mjs", import.meta.url)));
  return async (prompt, execution = {}) => {
    const adapter = await resolveWorkerAdapterDescriptor(cwd, workerAdapter);
    if (expectedAdapter && (adapter.adapterContentSha256 !== expectedAdapter.adapterContentSha256 || adapter.adapterPathSha256 !== expectedAdapter.adapterPathSha256)) throw new Error("worker adapter changed after session creation");
    return new Promise((resolveResult, reject) => {
      const runId = id(execution.runId, "runId"); const taskId = id(execution.taskId ?? execution.agentId, "taskId"); const attemptId = id(execution.attemptId ?? `attempt-${execution.attempt ?? 1}`, "attemptId");
      const request = { protocol: PROTOCOL, version: 1, kind: "request", runId, taskId, attemptId, prompt: String(prompt), workspaceRoot: adapter.workspaceRoot, providerMode: "trusted-adapter", adapterModule: adapter.adapterModule, adapterContentSha256: adapter.adapterContentSha256, adapterPathSha256: adapter.adapterPathSha256 };
      const requestLine = `${JSON.stringify(request)}\n`;
      if (byteLength(requestLine) > 64 * 1024) throw new Error("worker request exceeded byte cap");
      const child = spawn(nodePath, [script], { cwd: adapter.workspaceRoot, env: workerEnvironment(), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const spawnedAt = new Date().toISOString();
      let stdout = ""; let stdoutBytes = 0; let stderrBytes = 0; const stderrHash = createHash("sha256");
      let settled = false; let terminationReason; let timeout; let escalation; let cleanupDeadline; let reportPromise = Promise.resolve();
      const abort = () => terminate("worker cancelled");
      const cleanup = () => { clearTimeout(timeout); clearTimeout(escalation); clearTimeout(cleanupDeadline); execution.signal?.removeEventListener("abort", abort); };
      const finish = (error, value) => { if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolveResult(value); };
      function terminate(reason) {
        if (settled || terminationReason) return;
        terminationReason = reason;
        child.kill("SIGTERM");
        escalation = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
        cleanupDeadline = setTimeout(() => finish(processError(`${reason}; direct child cleanup unverified`, processEvidence(child, script, spawnedAt))), Math.max(killGraceMs * 4, 1_000));
        escalation.unref?.(); cleanupDeadline.unref?.();
      }
      child.once("spawn", () => {
        const evidence = processEvidence(child, script, spawnedAt);
        reportPromise = Promise.resolve(execution.reportProcess?.(evidence));
        reportPromise.catch(() => terminate("worker process identity persistence failed"));
      });
      child.stdout.on("data", chunk => { stdoutBytes += chunk.length; if (stdoutBytes > maxLineBytes) return terminate("worker stdout exceeded byte cap"); stdout += chunk.toString("utf8"); });
      child.stderr.on("data", chunk => { stderrBytes += chunk.length; stderrHash.update(chunk); if (stderrBytes > maxStderrBytes) terminate("worker stderr exceeded byte cap"); });
      child.once("error", error => finish(processError(`worker spawn failed: ${error.message}`, Number.isSafeInteger(child.pid) ? processEvidence(child, script, spawnedAt) : undefined)));
      child.once("close", async (code, signal) => {
        if (settled) return;
        try { await reportPromise; } catch { /* termination reason already records persistence failure */ }
        const process = processEvidence(child, script, spawnedAt, { childExitVerified: true, exitCode: code, exitSignal: signal ?? null, stderrBytes, stderrSha256: stderrHash.digest("hex") });
        if (terminationReason) return finish(processError(terminationReason, process));
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        if (lines.length !== 1) return finish(processError("invalid worker output: expected one result", process));
        let envelope; try { envelope = JSON.parse(lines[0]); } catch { return finish(processError("invalid worker JSON output", process)); }
        if (envelope.protocol !== PROTOCOL || envelope.version !== 1 || envelope.kind !== "result" || envelope.status !== "succeeded") return finish(processError("invalid worker result envelope", process));
        if (envelope.runId !== runId || envelope.taskId !== taskId || envelope.attemptId !== attemptId) return finish(processError("worker result identity mismatch", process));
        if (typeof envelope.result !== "string" || byteLength(envelope.result) > maxLineBytes) return finish(processError("worker result exceeded byte cap", process));
        if (code !== 0) return finish(processError(`worker exited (${code ?? signal})`, process));
        finish(null, { result: envelope.result, process });
      });
      timeout = setTimeout(() => terminate(`worker timeout after ${timeoutMs}ms`), timeoutMs); timeout.unref?.();
      if (execution.signal?.aborted) abort(); else execution.signal?.addEventListener("abort", abort, { once: true });
      child.stdin.end(requestLine);
    });
  };
}
