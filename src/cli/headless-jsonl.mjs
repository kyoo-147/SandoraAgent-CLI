// Compatibility composition entrypoint; transport is owned by apps/headless.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runHeadless, JSONL_PROTOCOL, JSONL_VERSION } from "@sandora/headless";
import { createSandoraSession } from "../runtime/create-session.mjs";
import { createCodingTools } from "../tools/coding-tools.mjs";
import { ApprovalStore } from "../tools/approvals.mjs";
import { createGitTools } from "../git/tools.mjs";
import { browserTools } from "../browser/tools.mjs";

export { JSONL_PROTOCOL, JSONL_VERSION };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cwd = process.cwd();
  await runHeadless({
    cwd,
    createSession: createSandoraSession,
    approvals: new ApprovalStore({ cwd }),
    customTools: [...createCodingTools(), ...createGitTools(), ...browserTools],
  });
}
