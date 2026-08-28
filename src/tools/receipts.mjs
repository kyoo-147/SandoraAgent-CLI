import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineTool, toolText } from "./registry.mjs";

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

function authorityFor(toolName) {
  const rules = [[/^browser_click$/, "SANDORA_ALLOW_BROWSER_SUBMIT"], [/^worker_integrate$/, "SANDORA_ALLOW_WORKER_INTEGRATION"], [/^git_merge$/, "SANDORA_ALLOW_LOCAL_MERGE"], [/^github_pr_merge$/, "SANDORA_ALLOW_PR_MERGE"], [/^workspace_shell$/, "SANDORA_ALLOW_PACKAGE_SCRIPTS"]];
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
  const validResult = success ? record.outcome === "SUCCEEDED" && /^[a-f0-9]{64}$/.test(record.resultSha256) && Number.isSafeInteger(record.resultBytes) && record.resultBytes >= 0 : record?.state === "FAILED" && ["FAILED", "BLOCKED"].includes(record.outcome) && /^[a-f0-9]{64}$/.test(record.errorSha256) && (record.errorCode === null || typeof record.errorCode === "string");
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
  }

  async execute({ toolCallId, toolName, args, invoke }) {
    if (typeof toolCallId !== "string" || !toolCallId) throw new Error("Tool call identity is required for receipt execution");
    const inputSha256 = canonicalInputSha256(args || {});
    const idempotencyKey = `${this.sessionId}:${toolCallId}`;
    const receiptId = createHash("sha256").update(`${idempotencyKey}:${toolName}:${inputSha256}`).digest("hex");
    const basePath = join(this.directory, createHash("sha256").update(idempotencyKey).digest("hex"));
    const startedPath = `${basePath}.started.json`;
    const terminalPath = `${basePath}.terminal.json`;
    const ownerToken = randomUUID();
    const common = { receiptVersion: 2, receiptId, idempotencyKey, runtime: this.runtime, sessionId: this.sessionId, toolCallId, attempt: 1, toolName, inputSha256, ownerToken, approval: { status: "NOT_RECORDED", reference: null }, authority: authorityFor(toolName), preflight: "DELEGATED_TO_TOOL", enforcement: "APPLICATION_POLICY", sandbox: "UNAVAILABLE_APPLICATION_ONLY", durability: "FILE_FSYNC" };
    const started = sealRecord({ ...common, state: "STARTED", outcome: "PENDING", startedAt: new Date().toISOString() });
    await mkdir(dirname(startedPath), { recursive: true });
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
    try { result = await invoke(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const blocked = /blocked|refus|requires|disabled|authority|policy|not available/i.test(message);
      try { const { recordSha256: priorRecordSha256, ...startedFields } = started; await durableWriteExclusive(terminalPath, sealRecord({ ...startedFields, priorRecordSha256, state: "FAILED", outcome: blocked ? "BLOCKED" : "FAILED", terminalAt: new Date().toISOString(), errorCode: error?.code || null, errorSha256: createHash("sha256").update(message).digest("hex") })); }
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
  return tools.map(tool => defineTool({ ...tool, execute: (toolCallId, args, signal, update, context) => receipts.execute({ toolCallId, toolName: tool.name, args, invoke: () => tool.execute(toolCallId, args, signal, update, context) }) }));
}
