import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ApprovalStore } from "./approvals.mjs";
import { defineTool, toolText, validateToolArgs } from "./registry.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function canonical(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("Tool receipt input must contain finite numbers"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, seen)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Tool receipt input must be JSON-compatible");
  if (seen.has(value)) throw new TypeError("Tool receipt input must not be circular");
  seen.add(value);
  const result = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return result;
}

export function canonicalInputSha256(value) {
  return createHash("sha256").update(canonical(value ?? {})).digest("hex");
}

function authorityFor(toolName, args) {
  const remote = value => { try { const url = new URL(value); return !["127.0.0.1", "localhost", "::1"].includes(url.hostname); } catch { return false; } };
  const rules = [[/^browser_click$/, "SANDORA_ALLOW_BROWSER_SUBMIT"], [/^browser_upload$/, "SANDORA_ALLOW_BROWSER_UPLOAD"], [/^browser_download_wait$/, args?.retainPath ? "SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN" : null], [/^browser_connect$/, (args?.endpoint || process.env.SANDORA_CDP_URL) && remote(args?.endpoint || process.env.SANDORA_CDP_URL) ? "SANDORA_ALLOW_REMOTE_CDP" : "SANDORA_ALLOW_EXISTING_BROWSER_PROFILE"], [/^browser_launch$/, (args?.endpoint || process.env.SANDORA_CDP_URL) ? (remote(args?.endpoint || process.env.SANDORA_CDP_URL) ? "SANDORA_ALLOW_REMOTE_CDP" : "SANDORA_ALLOW_EXISTING_BROWSER_PROFILE") : null], [/^browser_navigate$/, "SANDORA_ALLOW_BROWSER_CROSS_ORIGIN"], [/^worker_integrate$/, "SANDORA_ALLOW_WORKER_INTEGRATION"], [/^git_merge$/, "SANDORA_ALLOW_LOCAL_MERGE"], [/^github_pr_merge$/, "SANDORA_ALLOW_PR_MERGE"], [/^workspace_shell$/, "SANDORA_ALLOW_PACKAGE_SCRIPTS"]];
  const variable = rules.find(([pattern]) => pattern.test(toolName))?.[1];
  return variable ? { variable, granted: process.env[variable] === "1" } : { variable: null, granted: null };
}

async function durableWriteExclusive(path, value) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

function sealRecord(record) {
  return { ...record, recordSha256: createHash("sha256").update(canonical(record)).digest("hex") };
}

function validSeal(record) {
  const sha = record?.recordSha256;
  const unsealed = record && Object.fromEntries(Object.entries(record).filter(([key]) => key !== "recordSha256"));
  return typeof sha === "string" && sha === createHash("sha256").update(canonical(unsealed)).digest("hex");
}
function exactKeys(record, expectedKeys) { return Object.keys(record || {}).sort().join("\0") === [...expectedKeys].sort().join("\0"); }
function validateCommon(record, expected) {
  if (record.receiptVersion !== 2 || record.idempotencyKey !== expected.idempotencyKey || record.sessionId !== expected.sessionId || record.runtime !== expected.runtime || record.toolCallId !== expected.toolCallId || record.attempt !== 1 || typeof record.ownerToken !== "string" || !record.ownerToken) throw new Error("TOOL_RECEIPT_UNKNOWN: receipt identity is invalid");
  if (record.toolName !== expected.toolName || record.inputSha256 !== expected.inputSha256) throw new Error("TOOL_RECEIPT_COLLISION: tool call identity was reused with different input");
  if (record.receiptId !== expected.receiptId) throw new Error("TOOL_RECEIPT_UNKNOWN: receipt identity seal is invalid");
  if (!exactKeys(record.approval, ["status", "reference"]) || typeof record.approval.status !== "string" || !exactKeys(record.authority, ["variable", "granted"]) || ![null, true, false].includes(record.authority.granted) || record.preflight !== "DELEGATED_TO_TOOL" || record.enforcement !== "APPLICATION_POLICY" || record.sandbox !== "UNAVAILABLE_APPLICATION_ONLY" || record.durability !== "FILE_FSYNC") throw new Error("TOOL_RECEIPT_UNKNOWN: receipt policy fields are invalid");
}
function validateClaim(record, expected) {
  const keys = [...Object.keys(expected), "state", "claimedAt", "recordSha256"];
  if (!exactKeys(record, keys) || !validSeal(record) || record.state !== "CLAIMED" || !Number.isFinite(Date.parse(record.claimedAt))) throw new Error("TOOL_RECEIPT_UNKNOWN: execution claim schema or seal is invalid");
  if (record.receiptVersion !== 2 || record.attempt !== 1 || typeof record.ownerToken !== "string" || !record.ownerToken || record.idempotencyKey !== expected.idempotencyKey || record.sessionId !== expected.sessionId || record.runtime !== expected.runtime || record.toolCallId !== expected.toolCallId) throw new Error("TOOL_RECEIPT_UNKNOWN: execution claim identity is invalid");
  if (record.toolName !== expected.toolName || record.inputSha256 !== expected.inputSha256 || record.receiptId !== expected.receiptId) throw new Error("TOOL_RECEIPT_COLLISION: tool call identity was reused with different input");
  return record;
}

function validateStart(record, expected) {
  const keys = [...Object.keys(expected), "state", "outcome", "startedAt", "recordSha256"];
  if (!exactKeys(record, keys) || !validSeal(record) || record.state !== "STARTED" || record.outcome !== "PENDING" || !Number.isFinite(Date.parse(record.startedAt))) throw new Error("TOOL_RECEIPT_UNKNOWN: STARTED receipt schema or seal is invalid");
  validateCommon(record, expected);
  return record;
}
function validateTerminal(record, expected, started) {
  const success = record?.state === "SUCCEEDED";
  const suffix = success ? ["resultSha256", "resultBytes"] : ["errorCode", "errorSha256"];
  const keys = [...Object.keys(expected), "state", "outcome", "startedAt", "priorRecordSha256", "terminalAt", ...suffix, "recordSha256"];
  const validResult = success ? record.outcome === "SUCCEEDED" && /^[a-f0-9]{64}$/.test(record.resultSha256) && Number.isSafeInteger(record.resultBytes) && record.resultBytes >= 0 : ["FAILED", "CANCELLED"].includes(record?.state) && ({ FAILED: ["FAILED", "BLOCKED"], CANCELLED: ["CANCELLED"] })[record.state].includes(record.outcome) && /^[a-f0-9]{64}$/.test(record.errorSha256) && (record.errorCode === null || typeof record.errorCode === "string");
  if (!exactKeys(record, keys) || !validSeal(record) || !validResult || !Number.isFinite(Date.parse(record.terminalAt)) || record.startedAt !== started.startedAt || record.priorRecordSha256 !== started.recordSha256) throw new Error("TOOL_RECEIPT_UNKNOWN: terminal receipt schema, seal, or STARTED binding is invalid");
  validateCommon(record, expected);
  for (const key of Object.keys(expected)) if (canonical(record[key]) !== canonical(started[key])) throw new Error("TOOL_RECEIPT_UNKNOWN: terminal receipt fields conflict with STARTED policy");
  return record;
}

export class ToolReceiptStore {
  constructor({ cwd, sessionId, runtime }) {
    if (!SAFE_ID.test(sessionId || "")) throw new Error("Invalid receipt session identity");
    if (!SAFE_ID.test(runtime || "")) throw new Error("Invalid receipt runtime identity");
    this.sessionId = sessionId;
    this.runtime = runtime;
    this.directory = join(cwd, ".sandora", "receipts", sessionId);
    this.approvals = new ApprovalStore({ cwd });
  }

  async execute({ toolCallId, toolName, args, signal, invoke, onPolicyDecision, onBeforeInvoke }) {
    if (typeof toolCallId !== "string" || !toolCallId) throw new Error("Tool call identity is required for receipt execution");
    const inputSha256 = canonicalInputSha256(args === undefined ? {} : args);
    const idempotencyKey = `${this.sessionId}:${toolCallId}`;
    const receiptId = createHash("sha256").update(`${idempotencyKey}:${toolName}:${inputSha256}`).digest("hex");
    const basePath = join(this.directory, createHash("sha256").update(idempotencyKey).digest("hex"));
    const claimPath = `${basePath}.claim.json`;
    const startedPath = `${basePath}.started.json`;
    const terminalPath = `${basePath}.terminal.json`;
    const ownerToken = randomUUID();
    const authority = authorityFor(toolName, args);
    const identity = { receiptVersion: 2, receiptId, idempotencyKey, runtime: this.runtime, sessionId: this.sessionId, toolCallId, attempt: 1, toolName, inputSha256, ownerToken };
    const claim = sealRecord({ ...identity, state: "CLAIMED", claimedAt: new Date().toISOString() });
    await mkdir(dirname(claimPath), { recursive: true });
    try { await durableWriteExclusive(claimPath, claim); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        validateClaim(JSON.parse(await readFile(claimPath, "utf8")), identity);
        const previous = JSON.parse(await readFile(startedPath, "utf8"));
        const expected = Object.fromEntries(Object.entries(previous).filter(([key]) => !["state", "outcome", "startedAt", "recordSha256"].includes(key)));
        validateStart(previous, expected);
        validateTerminal(JSON.parse(await readFile(terminalPath, "utf8")), expected, previous);
      } catch (readError) {
        if (readError.code === "ENOENT") throw new Error("TOOL_RECEIPT_UNKNOWN: prior execution claim has no complete receipt; automatic replay is blocked");
        if (/TOOL_RECEIPT_(UNKNOWN|COLLISION)/.test(readError.message)) throw readError;
        throw new Error(`TOOL_RECEIPT_UNKNOWN: claimed receipt cannot be read: ${readError.message}`);
      }
      throw new Error("TOOL_RECEIPT_DUPLICATE: terminal execution already exists; automatic replay is blocked");
    }
    const approval = await this.approvals.consume({ toolName, inputSha256, authorityVariable: authority.variable });
    await onPolicyDecision?.({ inputSha256, authority, approval });
    const common = { ...identity, approval, authority, preflight: "DELEGATED_TO_TOOL", enforcement: "APPLICATION_POLICY", sandbox: "UNAVAILABLE_APPLICATION_ONLY", durability: "FILE_FSYNC" };
    const started = sealRecord({ ...common, state: "STARTED", outcome: "PENDING", startedAt: new Date().toISOString() });
    try { await durableWriteExclusive(startedPath, started); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let previous;
      try { previous = validateStart(JSON.parse(await readFile(startedPath, "utf8")), common); }
      catch (readError) { if (/TOOL_RECEIPT_UNKNOWN/.test(readError.message)) throw readError; throw new Error(`TOOL_RECEIPT_UNKNOWN: receipt cannot be read: ${readError.message}`); }
      try { validateTerminal(JSON.parse(await readFile(terminalPath, "utf8")), common, previous); }
      catch (readError) { if (readError.code === "ENOENT") throw new Error("TOOL_RECEIPT_UNKNOWN: prior execution has no terminal receipt; automatic replay is blocked"); if (/TOOL_RECEIPT_UNKNOWN|TOOL_RECEIPT_COLLISION/.test(readError.message)) throw readError; throw new Error(`TOOL_RECEIPT_UNKNOWN: terminal receipt cannot be read: ${readError.message}`); }
      throw new Error("TOOL_RECEIPT_DUPLICATE: terminal execution already exists; automatic replay is blocked");
    }
    let result;
    if (approval.status !== "NOT_REQUIRED" && approval.status !== "APPROVED") {
      const error = Object.assign(new Error(`Explicit approval ${approval.status.toLowerCase()} for ${toolName}`), { code: `SANDORA_APPROVAL_${approval.status}` });
      try { const { recordSha256: priorRecordSha256, ...startedFields } = started; await durableWriteExclusive(terminalPath, sealRecord({ ...startedFields, priorRecordSha256, state: "FAILED", outcome: "BLOCKED", terminalAt: new Date().toISOString(), errorCode: error.code, errorSha256: createHash("sha256").update(error.message).digest("hex") })); } catch (receiptError) { throw new AggregateError([error, receiptError], "Approval blocked and terminal receipt persistence failed"); }
      throw error;
    }
    try { await onBeforeInvoke?.({ inputSha256, authority, approval }); result = await invoke(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const blocked = /blocked|refus|requires|disabled|authority|policy|not available/i.test(message);
      const cancelled = signal?.aborted === true;
      try { const { recordSha256: priorRecordSha256, ...startedFields } = started; await durableWriteExclusive(terminalPath, sealRecord({ ...startedFields, priorRecordSha256, state: cancelled ? "CANCELLED" : "FAILED", outcome: cancelled ? "CANCELLED" : blocked ? "BLOCKED" : "FAILED", terminalAt: new Date().toISOString(), errorCode: error?.code || null, errorSha256: createHash("sha256").update(message).digest("hex") })); }
      catch (receiptError) { throw new AggregateError([error, receiptError], "Tool failed and terminal receipt persistence failed"); }
      throw error;
    }
    const output = toolText(result);
    const { recordSha256: priorRecordSha256, ...startedFields } = started;
    try { await durableWriteExclusive(terminalPath, sealRecord({ ...startedFields, priorRecordSha256, state: "SUCCEEDED", outcome: "SUCCEEDED", terminalAt: new Date().toISOString(), resultSha256: createHash("sha256").update(output).digest("hex"), resultBytes: Buffer.byteLength(output) })); }
    catch (error) { throw new Error(`TOOL_RECEIPT_UNKNOWN: tool returned but terminal receipt persistence failed: ${error.message}`, { cause: error }); }
    return result;
  }
}

export function wrapToolsWithReceipts(tools, options) {
  const receipts = new ToolReceiptStore(options);
  return tools.map(tool => defineTool({ ...tool, execute: async (toolCallId, args, signal, update, context) => { const input = args === undefined ? {} : args; validateToolArgs(tool, input); return receipts.execute({ toolCallId, toolName: tool.name, args: input, signal, invoke: () => tool.execute(toolCallId, input, signal, update, context) }); } }));
}
