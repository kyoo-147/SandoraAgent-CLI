import { appendFile } from "node:fs/promises";
import { ToolReceiptStore } from "../src/tools/receipts.mjs";

const [cwd, marker] = process.argv.slice(2);
if (!cwd || !marker) throw new Error("receipt worker requires cwd and marker path");
try {
  await new ToolReceiptStore({ cwd, sessionId: "process-shared", runtime: "native" }).execute({
    toolCallId: "same-call",
    toolName: "workspace_write",
    args: { path: "same" },
    invoke: async () => { await appendFile(marker, "x"); await new Promise(resolveDelay => setTimeout(resolveDelay, 50)); return "done"; },
  });
} catch (error) {
  if (!/TOOL_RECEIPT_UNKNOWN|TOOL_RECEIPT_DUPLICATE/.test(error.message)) throw error;
}
