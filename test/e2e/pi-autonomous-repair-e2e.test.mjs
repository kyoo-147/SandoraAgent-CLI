import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPiAgentSession } from "../../src/runtime/pi-agent-session.mjs";
import { createCodingTools } from "../../src/tools/coding-tools.mjs";
import { createGitTools } from "../../src/git/tools.mjs";

const execFile = promisify(execFileCallback);
const enabled = process.env.SANDORA_PI_E2E === "1";

test("real Pi agent diagnoses, repairs, retests, and reviews a disposable repository", { skip: enabled ? false : "set SANDORA_PI_E2E=1 with Pi credentials to run autonomous repair E2E", timeout: 240_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sandora-repair-e2e-"));
  let session;
  try {
    await writeFile(join(cwd, "math.mjs"), "export const add = (a, b) => a - b;\n");
    await writeFile(join(cwd, "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\ntest('adds', () => assert.equal(add(2, 3), 5));\n");
    await execFile("git", ["init", "-q", "-b", "main"], { cwd });
    await execFile("git", ["config", "user.email", "e2e@sandora.local"], { cwd });
    await execFile("git", ["config", "user.name", "Sandora E2E"], { cwd });
    await execFile("git", ["add", "."], { cwd });
    await execFile("git", ["commit", "-qm", "broken fixture"], { cwd });

    session = await createPiAgentSession({
      cwd,
      customTools: [...createCodingTools(), ...createGitTools()],
      systemPrompt: "You are Sandora's autonomous repair agent. Inspect evidence, reproduce failures, make the smallest safe edit, rerun tests, and review Git diff. Do not commit.",
    });
    const tools = [];
    session.subscribe(event => { if (event.type === "tool.start") tools.push(event.name); });
    await session.prompt("The repository has a bug. Reproduce it with node --test, diagnose it, repair it, rerun node --test until it passes, inspect the final Git diff, and summarize verified results. Do not commit.");

    assert.match(await readFile(join(cwd, "math.mjs"), "utf8"), /a \+ b/);
    await execFile(process.execPath, ["--test"], { cwd, timeout: 30_000 });
    assert.ok(tools.filter(name => name === "workspace_shell").length >= 2, `expected failure and passing retest, got ${tools.join(", ")}`);
    assert.ok(tools.includes("workspace_edit") || tools.includes("workspace_write"));
    assert.ok(tools.includes("git_diff") || tools.includes("git_status"));
    assert.match(session.getLastAssistantText() || "", /pass|fixed|repair/i);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
