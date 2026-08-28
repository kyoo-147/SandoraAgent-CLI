import { createHash } from "node:crypto";
import { join } from "node:path";
import { JsonlSessionStore } from "../runtime/turn-runtime.mjs";
import { defineTool, toolText } from "./registry.mjs";

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
  const rules = [
    [/^browser_click$/, "SANDORA_ALLOW_BROWSER_SUBMIT"],
    [/^worker_integrate$/, "SANDORA_ALLOW_WORKER_INTEGRATION"],
    [/^git_merge$/, "SANDORA_ALLOW_LOCAL_MERGE"],
    [/^github_pr_merge$/, "SANDORA_ALLOW_PR_MERGE"],
    [/^workspace_shell$/, "SANDORA_ALLOW_PACKAGE_SCRIPTS"],
  ];
  const variable = rules.find(([pattern]) => pattern.test(toolName))?.[1];
  return variable ? { variable, granted: process.env[variable] === "1" } : { variable: null, granted: null };
}

export class ToolReceiptStore {
  #tail = Promise.resolve();
  constructor({ cwd, sessionId, runtime }) {
    this.sessionId = sessionId;
    this.runtime = runtime;
    this.store = new JsonlSessionStore(join(cwd, ".sandora", "receipts", `${sessionId}.jsonl`));
  }

  execute({ toolCallId, toolName, args, invoke }) {
    if (typeof toolCallId !== "string" || !toolCallId) return Promise.reject(new Error("Tool call identity is required for receipt execution"));
    const pending = this.#tail.then(async () => {
      const inputSha256 = canonicalInputSha256(args || {});
      const idempotencyKey = `${this.sessionId}:${toolCallId}`;
      const receiptId = createHash("sha256").update(`${idempotencyKey}:${toolName}:${inputSha256}`).digest("hex");
      const previous = (await this.store.replay()).filter(event => event.type === "tool.receipt" && event.idempotencyKey === idempotencyKey);
      if (previous.some(event => event.inputSha256 !== inputSha256 || event.toolName !== toolName)) throw new Error("TOOL_RECEIPT_COLLISION: tool call identity was reused with different input");
      if (previous.some(event => event.phase === "started") && !previous.some(event => event.phase === "succeeded" || event.phase === "failed")) throw new Error("TOOL_RECEIPT_UNKNOWN: prior execution has no terminal receipt; automatic replay is blocked");
      if (previous.some(event => event.phase === "succeeded" || event.phase === "failed")) throw new Error("TOOL_RECEIPT_DUPLICATE: terminal execution already exists; automatic replay is blocked");
      const common = { type: "tool.receipt", receiptVersion: 1, receiptId, idempotencyKey, runtime: this.runtime, sessionId: this.sessionId, toolCallId, attempt: 1, toolName, inputSha256, approval: { status: "NOT_RECORDED", reference: null }, authority: authorityFor(toolName), preflight: "DELEGATED_TO_TOOL", enforcement: "APPLICATION_POLICY", sandbox: "UNAVAILABLE_APPLICATION_ONLY" };
      await this.store.append({ ...common, phase: "started", outcome: "PENDING" });
      try {
        const result = await invoke();
        const output = toolText(result);
        await this.store.append({ ...common, phase: "succeeded", outcome: "SUCCEEDED", resultSha256: createHash("sha256").update(output).digest("hex"), resultBytes: Buffer.byteLength(output) });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const blocked = /blocked|refus|requires|disabled|authority|policy|not available/i.test(message);
        await this.store.append({ ...common, phase: "failed", outcome: blocked ? "BLOCKED" : "FAILED", errorCode: error?.code || null, errorSha256: createHash("sha256").update(message).digest("hex") });
        throw error;
      }
    });
    this.#tail = pending.catch(() => {});
    return pending;
  }
}

export function wrapToolsWithReceipts(tools, options) {
  const receipts = new ToolReceiptStore(options);
  return tools.map(tool => defineTool({ ...tool, execute: (toolCallId, args, signal, update, context) => receipts.execute({ toolCallId, toolName: tool.name, args, invoke: () => tool.execute(toolCallId, args, signal, update, context) }) }));
}
