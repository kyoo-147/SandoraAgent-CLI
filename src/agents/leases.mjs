import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATES = new Set(["ACQUIRED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]);
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function validateId(value, label) { if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid lease ${label}`); return value; }
function finiteTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }

async function writeExclusive(path, record) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}
async function replaceDurable(path, record) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeExclusive(temporary, record);
  await rename(temporary, path);
}

export class FileTaskLeaseManager {
  constructor({ leaseRoot, ownerId = randomUUID(), ttlMs = 10 * 60_000, now = () => Date.now(), lockTimeoutMs = 1_000 } = {}) {
    if (!leaseRoot) throw new Error("leaseRoot is required");
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000) throw new Error("lease ttlMs must be at least 1000");
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0) throw new Error("lease lockTimeoutMs must be non-negative");
    this.leaseRoot = resolve(leaseRoot); this.ownerId = ownerId; this.ttlMs = ttlMs; this.now = now; this.lockTimeoutMs = lockTimeoutMs;
  }
  directory(runId, agentId) { validateId(runId, "run id"); validateId(agentId, "agent id"); return resolve(this.leaseRoot, createHash("sha256").update(`${runId}\0${agentId}`).digest("hex")); }
  path(runId, agentId) { return resolve(this.directory(runId, agentId), "lease.json"); }
  async read(runId, agentId) {
    let record;
    try { record = JSON.parse(await readFile(this.path(runId, agentId), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw new Error(`RECONCILE_REQUIRED: invalid task lease: ${error.message}`); }
    const valid = record?.version === 1 && record.runId === runId && record.agentId === agentId && ID.test(record.ownerId || "") && typeof record.fenceToken === "string" && record.fenceToken.length >= 16 && STATES.has(record.state) && Number.isInteger(record.attempt) && record.attempt >= 1 && typeof record.idempotencyKey === "string" && record.idempotencyKey && finiteTimestamp(record.acquiredAt) && finiteTimestamp(record.updatedAt) && finiteTimestamp(record.expiresAt);
    if (!valid) throw new Error("RECONCILE_REQUIRED: task lease schema or identity is invalid");
    return record;
  }
  async #withLock(runId, agentId, operation) {
    const lock = resolve(this.directory(runId, agentId), ".transition-lock");
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try { await mkdir(lock); break; }
      catch (error) { if (error.code !== "EEXIST") throw error; if (Date.now() >= deadline) throw new Error("RECONCILE_REQUIRED: task lease transition lock is busy or stranded"); await sleep(10); }
    }
    try { return await operation(); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
  async acquire({ runId, agentId, attempt, idempotencyKey }) {
    const directory = this.directory(runId, agentId); const now = this.now();
    const record = { version: 1, runId, agentId, attempt, idempotencyKey, ownerId: this.ownerId, fenceToken: randomUUID(), state: "ACQUIRED", acquiredAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString() };
    await mkdir(this.leaseRoot, { recursive: true });
    try { await mkdir(directory); await writeExclusive(this.path(runId, agentId), record); return record; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await this.read(runId, agentId);
      if (!existing) throw new Error("RECONCILE_REQUIRED: lease directory exists without a record");
      if (existing.idempotencyKey !== idempotencyKey) throw new Error("LEASE_IDENTITY_COLLISION: existing lease has different idempotency identity");
      if (TERMINAL.has(existing.state)) throw new Error(`LEASE_TERMINAL: task already ended as ${existing.state}`);
      if (Date.parse(existing.expiresAt) <= now) throw new Error("RECONCILE_REQUIRED: prior task ownership expired without an authoritative terminal result");
      throw new Error("OWNER_BUSY: task has an unexpired owner");
    }
  }
  async transition(record, state, details = {}) {
    if (!STATES.has(state)) throw new Error("Invalid lease transition state");
    const allowedDetails = new Set(["dispatchedAt", "terminalAt", "reason"]);
    const unsupported = Object.keys(details).filter(key => !allowedDetails.has(key));
    if (unsupported.length) throw new Error(`Invalid lease transition details: ${unsupported.join(", ")}`);
    if ((details.dispatchedAt !== undefined && !finiteTimestamp(details.dispatchedAt)) || (details.terminalAt !== undefined && !finiteTimestamp(details.terminalAt)) || (details.reason !== undefined && typeof details.reason !== "string")) throw new Error("Invalid lease transition detail values");
    return this.#withLock(record.runId, record.agentId, async () => {
      const current = await this.read(record.runId, record.agentId);
      if (!current || current.ownerId !== record.ownerId || current.fenceToken !== record.fenceToken) throw new Error("LEASE_FENCED: stale task owner cannot update lease");
      if (TERMINAL.has(current.state)) throw new Error("LEASE_FENCED: terminal task lease cannot transition");
      if (Date.parse(current.expiresAt) <= this.now()) throw new Error("LEASE_EXPIRED: task owner cannot update an expired lease; reconciliation is required");
      const allowed = current.state === "ACQUIRED" ? new Set(["RUNNING", "CANCELLED", "FAILED"]) : new Set(["COMPLETED", "FAILED", "CANCELLED"]);
      if (!allowed.has(state)) throw new Error(`Invalid lease transition ${current.state} -> ${state}`);
      const now = this.now();
      const next = { ...current, ...details, state, updatedAt: new Date(now).toISOString(), expiresAt: TERMINAL.has(state) ? current.expiresAt : new Date(now + this.ttlMs).toISOString() };
      await replaceDurable(this.path(record.runId, record.agentId), next);
      return next;
    });
  }
  async reconcileExpired({ runId, agentId, expectedFenceToken, resolution = "CANCELLED" }) {
    if (!TERMINAL.has(resolution)) throw new Error("Reconciliation resolution must be terminal");
    return this.#withLock(runId, agentId, async () => {
      const current = await this.read(runId, agentId);
      if (!current || current.fenceToken !== expectedFenceToken) throw new Error("LEASE_FENCED: reconciliation target changed");
      if (TERMINAL.has(current.state)) throw new Error("LEASE_TERMINAL: reconciliation target is already terminal");
      if (Date.parse(current.expiresAt) > this.now()) throw new Error("OWNER_BUSY: unexpired ownership cannot be reconciled");
      const now = this.now();
      const next = { ...current, ownerId: this.ownerId, fenceToken: randomUUID(), state: resolution, reconciledFrom: { ownerId: current.ownerId, fenceToken: current.fenceToken }, updatedAt: new Date(now).toISOString(), terminalAt: new Date(now).toISOString() };
      await replaceDurable(this.path(runId, agentId), next);
      return next;
    });
  }
}
