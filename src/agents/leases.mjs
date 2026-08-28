import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

function validateId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid lease ${label}`);
  return value;
}

export class FileTaskLeaseManager {
  constructor({ leaseRoot, ownerId = randomUUID(), ttlMs = 10 * 60_000, now = () => Date.now() } = {}) {
    if (!leaseRoot) throw new Error("leaseRoot is required");
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000) throw new Error("lease ttlMs must be at least 1000");
    this.leaseRoot = resolve(leaseRoot); this.ownerId = ownerId; this.ttlMs = ttlMs; this.now = now;
  }
  directory(runId, agentId) { validateId(runId, "run id"); validateId(agentId, "agent id"); return resolve(this.leaseRoot, createHash("sha256").update(`${runId}\0${agentId}`).digest("hex")); }
  path(runId, agentId) { return resolve(this.directory(runId, agentId), "lease.json"); }
  async read(runId, agentId) {
    let record;
    try { record = JSON.parse(await readFile(this.path(runId, agentId), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw new Error(`RECONCILE_REQUIRED: invalid task lease: ${error.message}`); }
    if (record.version !== 1 || record.runId !== runId || record.agentId !== agentId || !record.ownerId || !record.fenceToken || !record.state) throw new Error("RECONCILE_REQUIRED: task lease identity is invalid");
    return record;
  }
  async acquire({ runId, agentId, attempt, idempotencyKey }) {
    const directory = this.directory(runId, agentId);
    const now = this.now();
    const record = { version: 1, runId, agentId, attempt, idempotencyKey, ownerId: this.ownerId, fenceToken: randomUUID(), state: "ACQUIRED", acquiredAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString() };
    await mkdir(this.leaseRoot, { recursive: true });
    try { await mkdir(directory, { recursive: false }); await writeFile(this.path(runId, agentId), JSON.stringify(record, null, 2) + "\n", { flag: "wx" }); return record; }
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
    const current = await this.read(record.runId, record.agentId);
    if (!current || current.ownerId !== record.ownerId || current.fenceToken !== record.fenceToken) throw new Error("LEASE_FENCED: stale task owner cannot update lease");
    const now = this.now();
    const next = { ...current, ...details, state, updatedAt: new Date(now).toISOString(), expiresAt: TERMINAL.has(state) ? current.expiresAt : new Date(now + this.ttlMs).toISOString() };
    const temporary = `${this.path(record.runId, record.agentId)}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx" });
    const rechecked = await this.read(record.runId, record.agentId);
    if (rechecked.fenceToken !== record.fenceToken) throw new Error("LEASE_FENCED: task owner changed before update");
    await rename(temporary, this.path(record.runId, record.agentId));
    return next;
  }
}
