import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { FileTaskLeaseManager } from "./leases.mjs";

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_RAMP_STEP = 1;
const DEFAULT_CANCEL_TIMEOUT_MS = 1_000;

function cloneAndFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)])));
}

function canonical(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function stableId(prefix, value) {
  return `${prefix}-${createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

function normalizeTask(task, index) {
  if (typeof task === "string") task = { prompt: task };
  if (!task || typeof task !== "object") throw new TypeError("each task must be an object or string");
  const key = task.id ?? task.key ?? task.name ?? `task-${index}`;
  return { ...task, key: String(key), agentId: task.agentId ?? stableId("agent", key), status: "queued", attempts: task.attempts ?? 0, result: undefined, error: undefined, artifacts: [] };
}

function budgetFor(task) {
  const budget = task.budget ?? {};
  const wallTimeMs = budget.wallTimeMs;
  if (wallTimeMs !== undefined && (!Number.isFinite(wallTimeMs) || wallTimeMs <= 0)) throw new RangeError(`task ${task.key} wallTimeMs must be positive`);
  const unsupported = Object.keys(budget).filter((key) => key !== "wallTimeMs");
  return { wallTimeMs, unsupported };
}

/**
 * In-process bounded scheduler. The runner receives an isolated frozen boundary.
 * In-process work cannot be force-killed: cancellation and wall-time limits settle
 * manager state after a bounded grace period, while uncooperative runner work may
 * continue in the background and must not retain manager ownership.
 */
export class SandoraAgentManager extends EventEmitter {
  constructor({ runner, maxConcurrency = DEFAULT_MAX_CONCURRENCY, rampStep = DEFAULT_RAMP_STEP, cancellationTimeoutMs = DEFAULT_CANCEL_TIMEOUT_MS, id = "default", leaseRoot, leaseTtlMs, leaseManager } = {}) {
    super();
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new RangeError("maxConcurrency must be a positive integer");
    if (!Number.isInteger(rampStep) || rampStep < 1) throw new RangeError("rampStep must be a positive integer");
    if (!Number.isInteger(cancellationTimeoutMs) || cancellationTimeoutMs < 0) throw new RangeError("cancellationTimeoutMs must be a non-negative integer");
    this.runner = runner; this.maxConcurrency = maxConcurrency; this.rampStep = rampStep; this.cancellationTimeoutMs = cancellationTimeoutMs; this.id = String(id); this.runs = new Map();
    this.leases = leaseManager ?? (leaseRoot ? new FileTaskLeaseManager({ leaseRoot, ttlMs: leaseTtlMs }) : null);
  }

  start(tasks, { runId, idempotencyKey } = {}) {
    if (!Array.isArray(tasks) || tasks.length === 0) throw new TypeError("tasks must be a non-empty array");
    const normalized = tasks.map(normalizeTask);
    const keys = new Set(); const agents = new Set();
    for (const task of normalized) {
      if (keys.has(task.key)) throw new Error(`duplicate task key: ${task.key}`);
      if (agents.has(task.agentId)) throw new Error(`duplicate agent ID: ${task.agentId}`);
      keys.add(task.key); agents.add(task.agentId); budgetFor(task);
    }
    normalized.sort((a, b) => a.key.localeCompare(b.key));
    const identity = idempotencyKey === undefined ? canonical(normalized.map(({ prompt, task, config, context, tools, model, budget, key, agentId }) => ({ prompt, task, config, context, tools, model, budget, key, agentId }))) : `idempotency:${idempotencyKey}`;
    const id = runId ?? stableId("run", `${this.id}:${identity}`);
    if (this.runs.has(id)) {
      const existing = this.runs.get(id);
      if (existing.identity !== identity) throw new Error(`run ID collision: ${id}`);
      return existing.promise;
    }
    const run = this.#newRun(id, normalized, identity);
    this.runs.set(id, run); run.promise = this.#schedule(run); return run.promise;
  }

  #newRun(id, tasks, identity) { return { id, identity, runner: this.runner, tasks: new Map(tasks.map((task) => [task.agentId, task])), queue: tasks, active: 0, unsettled: 0, limit: Math.min(this.rampStep, this.maxConcurrency), cancelled: false, controller: new AbortController(), promise: null }; }

  cancel(runId, agentId) {
    const run = this.runs.get(runId); if (!run) return false;
    if (agentId) {
      const task = run.tasks.get(agentId); if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return false;
      task.status = "cancelled"; task.error = "cancelled"; task.controller?.abort(); this.#emit(run, task); return true;
    }
    run.cancelled = true; run.controller.abort();
    for (const task of run.tasks.values()) if (["queued", "running"].includes(task.status)) { task.status = "cancelled"; task.error = "cancelled"; task.controller?.abort(); this.#emit(run, task); }
    return true;
  }

  status(runId, agentId) {
    const run = this.runs.get(runId); if (!run) return undefined;
    if (agentId) return this.#snapshot(run.tasks.get(agentId));
    return cloneAndFreeze({ runId, cancelled: run.cancelled, active: run.active, unsettled: run.unsettled, limit: run.limit, tasks: [...run.tasks.values()].map((task) => this.#snapshot(task)) });
  }

  result(runId, agentId) {
    const task = this.runs.get(runId)?.tasks.get(agentId); if (!task || task.status !== "completed") return undefined;
    return cloneAndFreeze({ result: task.result, artifacts: task.artifacts });
  }

  resume(runId, { runner } = {}) {
    const run = this.runs.get(runId); if (!run) throw new Error(`Unknown run: ${runId}`);
    if (run.active || run.unsettled || [...run.tasks.values()].some((task) => ["queued", "running"].includes(task.status))) throw new Error("cannot resume while a task is queued or running");
    const unfinished = [...run.tasks.values()].filter((task) => task.status === "failed" || task.status === "cancelled");
    if (!unfinished.length) return run.promise;
    if (runner) { if (typeof runner !== "function") throw new TypeError("runner must be a function"); run.runner = runner; }
    run.cancelled = false; run.controller = new AbortController(); run.limit = Math.min(this.rampStep, this.maxConcurrency);
    for (const task of unfinished) { task.status = "queued"; task.error = undefined; task.result = undefined; task.artifacts = []; }
    run.queue = unfinished;
    run.promise = this.#schedule(run); return run.promise;
  }

  async #schedule(run) {
    while (run.queue.some((task) => task.status === "queued") || run.active) {
      const next = run.queue.filter((task) => task.status === "queued").slice(0, Math.max(0, run.limit - run.active));
      if (!next.length) { if (run.active) await new Promise((resolve) => this.once(`idle:${run.id}`, resolve)); else break; continue; }
      await Promise.all(next.map((task) => this.#execute(run, task))); run.limit = Math.min(this.maxConcurrency, run.limit + this.rampStep);
    }
    const status = this.status(run.id); this.emit("complete", status); return status;
  }

  async #execute(run, task) {
    if (run.cancelled || task.status !== "queued") return;
    let lease;
    if (this.leases) {
      try { lease = await this.leases.acquire({ runId: run.id, agentId: task.agentId, attempt: task.attempts + 1, idempotencyKey: run.identity }); await this.leases.transition(lease, "RUNNING", { dispatchedAt: new Date().toISOString() }); }
      catch (error) { task.status = "failed"; task.error = error instanceof Error ? error.message : String(error); this.#emit(run, task); return; }
    }
    if (run.cancelled || task.status !== "queued") {
      if (lease) { try { await this.leases.transition(lease, "CANCELLED", { terminalAt: new Date().toISOString(), reason: "cancelled-before-dispatch" }); } catch (error) { task.status = "failed"; task.error = error instanceof Error ? error.message : String(error); } }
      this.#emit(run, task);
      return;
    }
    task.status = "running"; task.attempts += 1; run.active += 1; run.unsettled += 1; this.#emit(run, task);
    const controller = new AbortController(); task.controller = controller;
    const abort = () => controller.abort(); run.controller.signal.addEventListener("abort", abort, { once: true });
    const budget = budgetFor(task); const execution = Object.freeze({ agentId: task.agentId, runId: run.id, fenceToken: lease?.fenceToken, config: cloneAndFreeze(task.config ?? {}), context: cloneAndFreeze(task.context ?? {}), tools: cloneAndFreeze(task.tools ?? []), model: task.model, budget: cloneAndFreeze(budget), signal: controller.signal });
    const runnerPromise = Promise.resolve().then(() => run.runner(task.prompt ?? task.task ?? task.key, execution));
    runnerPromise.then(() => {}, () => {});
    let timer; let outcome;
    const timeout = budget.wallTimeMs === undefined ? null : new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), budget.wallTimeMs); });
    const cancellation = new Promise((resolve) => { if (controller.signal.aborted) resolve({ kind: "cancel" }); else controller.signal.addEventListener("abort", () => { setTimeout(() => resolve({ kind: "cancel" }), this.cancellationTimeoutMs); }, { once: true }); });
    try {
      outcome = await Promise.race([runnerPromise.then((value) => ({ kind: "result", value }), (error) => ({ kind: "error", error })), ...(timeout ? [timeout] : []), cancellation]);
      if (outcome.kind === "result" && !controller.signal.aborted && !run.cancelled) { task.status = "completed"; task.result = outcome.value?.result ?? outcome.value; task.artifacts = Array.isArray(outcome.value?.artifacts) ? outcome.value.artifacts : []; }
      else if (outcome.kind === "error" && !controller.signal.aborted && !run.cancelled) { task.status = "failed"; task.error = outcome.error instanceof Error ? outcome.error.message : String(outcome.error); }
      else { task.status = "cancelled"; task.error = outcome.kind === "timeout" ? `wall-time budget exceeded (${budget.wallTimeMs}ms)` : "cancelled"; controller.abort(); }
      if (lease) {
        try { await this.leases.transition(lease, task.status.toUpperCase(), { terminalAt: new Date().toISOString() }); }
        catch (error) { task.status = "failed"; task.result = undefined; task.artifacts = []; task.error = error instanceof Error ? error.message : String(error); }
      }
    } finally {
      clearTimeout(timer); run.active -= 1; run.unsettled -= 1; run.controller.signal.removeEventListener("abort", abort); task.controller = undefined; this.#emit(run, task); this.emit(`idle:${run.id}`);
    }
  }

  #emit(run, task) { this.emit("status", this.#snapshot(task), this.status(run.id)); }
  #snapshot(task) { if (!task) return undefined; return cloneAndFreeze({ agentId: task.agentId, key: task.key, status: task.status, attempts: task.attempts, error: task.error, artifacts: task.artifacts, result: task.status === "completed" ? task.result : undefined }); }
}

export function createAgentManager(options) { return new SandoraAgentManager(options); }
export { stableId };
