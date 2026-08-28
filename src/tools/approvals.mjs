import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
function canonicalInput(value) { return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonicalInput).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalInput(value[key])}`).join(",")}}`; }
const canonicalInputSha256 = value => createHash("sha256").update(canonicalInput(value ?? {})).digest("hex");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VARIABLES = new Set(["SANDORA_ALLOW_BROWSER_SUBMIT", "SANDORA_ALLOW_BROWSER_UPLOAD", "SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN", "SANDORA_ALLOW_EXISTING_BROWSER_PROFILE", "SANDORA_ALLOW_BROWSER_CROSS_ORIGIN", "SANDORA_ALLOW_REMOTE_CDP", "SANDORA_ALLOW_PACKAGE_SCRIPTS", "SANDORA_ALLOW_WORKER_INTEGRATION", "SANDORA_ALLOW_LOCAL_MERGE", "SANDORA_ALLOW_PR_MERGE", "SANDORA_ALLOW_UNCHECKED_PR_MERGE"]);
const canonical = value => value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");

async function durableExclusive(path, value) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
}
function fail(message, code = "SANDORA_APPROVAL_INVALID") { throw Object.assign(new Error(message), { code }); }
function validDecision(value) { return value === "ALLOW" || value === "DENY"; }
async function withLock(path, action) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try { await mkdir(path); break; }
    catch (error) { if (error.code !== "EEXIST") throw error; if (Date.now() >= deadline) fail("approval state lock is busy or stranded", "SANDORA_APPROVAL_UNKNOWN"); await new Promise(resolveWait => setTimeout(resolveWait, 10)); }
  }
  try { return await action(); } finally { await rm(path, { recursive: true, force: true }); }
}

export class ApprovalStore {
  constructor({ cwd }) { this.root = join(cwd, ".sandora", "approvals"); this.decisions = join(this.root, "decisions"); this.uses = join(this.root, "uses"); this.scopeLocks = join(this.root, "scope-locks"); }
  async create({ toolName, args, inputSha256, authorityVariable, decision, expiresAt, maxUses = 1, scope = {} }) {
    if (typeof toolName !== "string" || !toolName || !SAFE_ID.test(toolName)) fail("approval toolName is required");
    if (!VARIABLES.has(authorityVariable)) fail("approval authority variable is not recognized");
    if (!validDecision(decision)) fail("approval decision must be ALLOW or DENY");
    const derivedInput = args === undefined ? null : canonicalInputSha256(args);
    if (inputSha256 && derivedInput && inputSha256 !== derivedInput) fail("approval inputSha256 does not match canonical args");
    const input = inputSha256 || derivedInput || canonicalInputSha256({});
    if (!/^[a-f0-9]{64}$/.test(input)) fail("approval inputSha256 is invalid");
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) fail("approval expiresAt must be a future timestamp");
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000) fail("approval maxUses must be between 1 and 1000");
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) fail("approval scope must be an object");
    const reserved = ["toolName", "inputSha256", "authorityVariable"].filter(key => Object.hasOwn(scope, key));
    if (reserved.length) fail(`approval scope cannot override reserved fields: ${reserved.join(", ")}`);
    const exactScope = { toolName, inputSha256: input, authorityVariable, ...scope };
    await mkdir(this.decisions, { recursive: true }); await mkdir(this.scopeLocks, { recursive: true });
    const scopeLock = join(this.scopeLocks, digest(exactScope));
    return withLock(scopeLock, async () => {
      const active = (await this.list()).find(item => canonical(item.scope) === canonical(exactScope) && Date.parse(item.expiresAt) > Date.now());
      if (active) fail("an active approval decision already exists for this exact scope", "SANDORA_APPROVAL_CONFLICT");
      const createdAt = new Date().toISOString();
      const reference = digest({ exactScope, decision, createdAt, expiresAt: new Date(expires).toISOString(), maxUses });
      const record = { approvalVersion: 1, reference, digest: reference, scope: exactScope, decision, createdAt, expiresAt: new Date(expires).toISOString(), maxUses, consumed: 0 };
      await durableExclusive(join(this.decisions, `${reference}.json`), record);
      return record;
    });
  }
  async list() {
    let names; try { names = await readdir(this.decisions); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const records = [];
    for (const name of names.filter(item => item.endsWith(".json"))) { try { records.push(this.#validate(JSON.parse(await readFile(join(this.decisions, name), "utf8")))); } catch { /* malformed decisions are intentionally not usable */ } }
    return records;
  }
  #validate(record) {
    if (record?.approvalVersion !== 1 || !SAFE_ID.test(record.scope?.toolName || "") || !VARIABLES.has(record.scope?.authorityVariable) || !/^[a-f0-9]{64}$/.test(record.scope?.inputSha256) || !validDecision(record.decision) || !/^[a-f0-9]{64}$/.test(record.reference) || record.digest !== record.reference || !Number.isSafeInteger(record.maxUses) || record.maxUses < 1 || !Number.isSafeInteger(record.consumed) || record.consumed < 0 || record.consumed > record.maxUses || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) fail("malformed approval decision");
    const { reference, digest: ignored, consumed, ...unsigned } = record;
    if (digest({ exactScope: record.scope, decision: record.decision, createdAt: record.createdAt, expiresAt: record.expiresAt, maxUses: record.maxUses }) !== reference) fail("approval digest mismatch");
    return record;
  }
  async consume({ toolName, inputSha256, authorityVariable }) {
    if (process.env.SANDORA_REQUIRE_APPROVALS !== "1") return { status: "NOT_REQUIRED", reference: null };
    if (!authorityVariable) return { status: "NOT_REQUIRED", reference: null };
    const candidates = (await this.list()).filter(item => item.scope.toolName === toolName && item.scope.inputSha256 === inputSha256 && item.scope.authorityVariable === authorityVariable).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const record = candidates[0];
    if (!record) return { status: "MISSING", reference: null };
    if (Date.parse(record.expiresAt) <= Date.now()) return { status: "STALE", reference: record.reference };
    if (record.decision !== "ALLOW") return { status: "DENIED", reference: record.reference };
    await mkdir(this.uses, { recursive: true });
    const lock = join(this.uses, `${record.reference}.lock`);
    return withLock(lock, async () => {
      const used = (await readdir(this.uses)).filter(name => name.startsWith(`${record.reference}.use.`)).length;
      if (used >= record.maxUses) return { status: "REPLAYED", reference: record.reference };
      await durableExclusive(join(this.uses, `${record.reference}.use.${used + 1}`), { reference: record.reference, use: used + 1, consumedAt: new Date().toISOString() });
      return { status: "APPROVED", reference: record.reference };
    });
  }
}

export function approvalScope({ toolName, args, authorityVariable }) { return { toolName, inputSha256: canonicalInputSha256(args || {}), authorityVariable }; }
