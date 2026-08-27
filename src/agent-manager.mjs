import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const DEFAULT_MAX_CONCURRENCY = 4;
function cloneAndFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)])));
}
const DEFAULT_RAMP_STEP = 1;

function stableId(prefix, value) {
  return `${prefix}-${createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

function normalizeTask(task, index) {
  if (typeof task === "string") task = { prompt: task };
  const key = task.id ?? task.key ?? task.name ?? `task-${index}`;
  return {
    ...task,
    key: String(key),
    agentId: task.agentId ?? stableId("agent", key),
    status: "queued",
    attempts: task.attempts ?? 0,
    result: undefined,
    error: undefined,
    artifacts: [],
  };
}

/**
 * A small in-process scheduler. The runner is injected so the manager does not
 * own a model or tools; each invocation receives a fresh, immutable execution
 * boundary and an AbortSignal. This also makes it useful with Pi adapters and
 * deterministic test runners.
 */
export class SandoraAgentManager extends EventEmitter {
  constructor({ runner, maxConcurrency = DEFAULT_MAX_CONCURRENCY, rampStep = DEFAULT_RAMP_STEP, id = "default" } = {}) {
    super();
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new RangeError("maxConcurrency must be a positive integer");
    if (!Number.isInteger(rampStep) || rampStep < 1) throw new RangeError("rampStep must be a positive integer");
    this.runner = runner;
    this.maxConcurrency = maxConcurrency;
    this.rampStep = rampStep;
    this.id = String(id);
    this.runs = new Map();
  }

  start(tasks, { runId } = {}) {
    if (!Array.isArray(tasks) || tasks.length === 0) throw new TypeError("tasks must be a non-empty array");
    const normalized = tasks.map(normalizeTask).sort((a, b) => a.key.localeCompare(b.key));
    const id = runId ?? stableId("run", `${this.id}:${normalized.map((t) => t.key).join("|")}`);
    if (this.runs.has(id)) return this.runs.get(id).promise;
    const run = { id, tasks: new Map(normalized.map((task) => [task.agentId, task])), queue: normalized, active: 0, limit: Math.min(this.rampStep, this.maxConcurrency), cancelled: false, controller: new AbortController(), promise: null };
    this.runs.set(id, run);
    run.promise = this.#schedule(run);
    return run.promise;
  }

  cancel(runId, agentId) {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (agentId) {
      const task = run.tasks.get(agentId);
      if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return false;
      task.status = "cancelled";
      task.error = "cancelled";
      task.controller?.abort();
      this.#emit(run, task);
      return true;
    }
    run.cancelled = true;
    run.controller.abort();
    for (const task of run.tasks.values()) {
      if (["queued", "running"].includes(task.status)) { task.status = "cancelled"; task.error = "cancelled"; this.#emit(run, task); }
    }
    return true;
  }

  status(runId, agentId) {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    if (agentId) return this.#snapshot(run.tasks.get(agentId));
    return { runId, cancelled: run.cancelled, active: run.active, limit: run.limit, tasks: [...run.tasks.values()].map((task) => this.#snapshot(task)) };
  }

  result(runId, agentId) {
    const task = this.runs.get(runId)?.tasks.get(agentId);
    return task?.status === "completed" ? { result: task.result, artifacts: [...task.artifacts] } : undefined;
  }

  resume(runId, { runner } = {}) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const unfinished = [...run.tasks.values()].filter((task) => task.status === "failed" || task.status === "cancelled").map((task) => ({ ...task, status: "queued", attempts: task.attempts, result: undefined, error: undefined }));
    if (!unfinished.length) return run.promise;
    if (runner) this.runner = runner;
    this.runs.delete(runId);
    return this.start(unfinished, { runId });
  }

  async #schedule(run) {
    while (run.queue.some((task) => task.status === "queued") || run.active) {
      const available = Math.max(0, run.limit - run.active);
      const next = run.queue.filter((task) => task.status === "queued").slice(0, available);
      if (!next.length) { if (run.active) await new Promise((resolve) => this.once(`idle:${run.id}`, resolve)); else break; continue; }
      await Promise.all(next.map((task) => this.#execute(run, task)));
      run.limit = Math.min(this.maxConcurrency, run.limit + this.rampStep);
    }
    const status = this.status(run.id);
    this.emit("complete", status);
    return status;
  }

  async #execute(run, task) {
    if (run.cancelled || task.status !== "queued") return;
    task.status = "running"; task.attempts += 1; run.active += 1; this.#emit(run, task);
    const controller = new AbortController();
    task.controller = controller;
    const abort = () => controller.abort();
    run.controller.signal.addEventListener("abort", abort, { once: true });
    const execution = Object.freeze({ agentId: task.agentId, runId: run.id, config: cloneAndFreeze(task.config ?? {}), context: cloneAndFreeze(task.context ?? {}), tools: cloneAndFreeze(task.tools ?? []), model: task.model, budget: cloneAndFreeze(task.budget), signal: controller.signal });
    try {
      const value = await this.runner(task.prompt ?? task.task ?? task.key, execution);
      if (controller.signal.aborted || run.cancelled) { task.status = "cancelled"; task.error = "cancelled"; }
      else { task.status = "completed"; task.result = value?.result ?? value; task.artifacts = Array.isArray(value?.artifacts) ? value.artifacts : []; }
    } catch (error) {
      task.status = controller.signal.aborted || run.cancelled ? "cancelled" : "failed";
      task.error = error instanceof Error ? error.message : String(error);
    } finally {
      run.active -= 1; run.controller.signal.removeEventListener("abort", abort); task.controller = undefined; this.#emit(run, task); this.emit(`idle:${run.id}`);
    }
  }

  #emit(run, task) { this.emit("status", this.#snapshot(task), this.status(run.id)); }
  #snapshot(task) { if (!task) return undefined; return { agentId: task.agentId, key: task.key, status: task.status, attempts: task.attempts, error: task.error, artifacts: [...task.artifacts], result: task.status === "completed" ? task.result : undefined }; }
}

export function createAgentManager(options) { return new SandoraAgentManager(options); }
export { stableId };