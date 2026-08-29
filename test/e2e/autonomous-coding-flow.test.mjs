import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAgentSession } from "../../src/runtime/native-agent-session.mjs";
import { NativeToolRegistry } from "../../src/tools/registry.mjs";
import { createCodingTools } from "../../src/tools/coding-tools.mjs";
import { createGitTools } from "../../src/git/tools.mjs";

const execFile = promisify(execFileCallback);
const toolCall = (name, args, index) => ({ type: "tool_call_delta", index: 0, id: `call-${index}`, name, arguments: JSON.stringify(args) });

class RepairProvider {
  constructor() { this.model = "sandora-fixture-repair"; this.step = 0; this.observedFailure = false; this.observedPass = false; }
  async *stream({ messages }) {
    const previous = messages.at(-1);
    this.step += 1;
    if (this.step === 4) {
      assert.equal(previous.role, "tool");
      assert.match(previous.content, /exit 1/);
      this.observedFailure = true;
    }
    if (this.step === 6) {
      assert.equal(previous.role, "tool");
      assert.match(previous.content, /exit 0/);
      this.observedPass = true;
    }
    const plan = [
      ["workspace_list", { path: "." }],
      ["workspace_read", { path: "math.mjs" }],
      ["workspace_shell", { command: "node --test" }],
      ["workspace_edit", { path: "math.mjs", oldText: "a - b", newText: "a + b" }],
      ["workspace_shell", { command: "node --test" }],
      ["git_diff", {}],
      ["git_branch_create", { branch: "feat/repair" }],
      ["git_commit", { message: "fix: repair addition", paths: ["math.mjs"] }],
      ["git_push", { branch: "feat/repair", remote: "origin" }],
    ];
    if (this.step <= plan.length) {
      const [name, args] = plan[this.step - 1];
      yield toolCall(name, args, this.step);
      return;
    }
    yield { type: "text_delta", delta: "Verified failing test, repaired addition, retested successfully, reviewed diff, committed intended file, and pushed feature branch." };
    yield { type: "usage", usage: { prompt_tokens: 100, completion_tokens: 20 } };
  }
}

test("autonomous session completes inspect-fail-diagnose-repair-retest-diff-commit-push flow", { timeout: 60_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sandora-autonomous-flow-"));
  const remote = `${cwd}-remote.git`;
  let session;
  try {
    await writeFile(join(cwd, "math.mjs"), "export const add = (a, b) => a - b;\n");
    await writeFile(join(cwd, "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\ntest('adds', () => assert.equal(add(2, 3), 5));\n");
    await writeFile(join(cwd, "unrelated.txt"), "preserve me\n");
    await execFile("git", ["init", "-q", "-b", "main"], { cwd });
    await execFile("git", ["config", "user.email", "e2e@sandora.local"], { cwd });
    await execFile("git", ["config", "user.name", "Sandora E2E"], { cwd });
    await execFile("git", ["add", "math.mjs", "math.test.mjs"], { cwd });
    await execFile("git", ["commit", "-qm", "broken fixture"], { cwd });
    await execFile("git", ["init", "--bare", "-q", remote]);
    await execFile("git", ["remote", "add", "origin", remote], { cwd });

    const provider = new RepairProvider();
    const registry = new NativeToolRegistry().registerAll([...createCodingTools(), ...createGitTools()]);
    session = await createAgentSession({ cwd, provider, registry, maxSteps: 12 });
    const started = [];
    session.subscribe(event => { if (event.type === "tool.start") started.push(event.name); });
    await session.prompt("Repair the failing repository and deliver the verified fix on a feature branch.");

    assert.equal(provider.observedFailure, true);
    assert.equal(provider.observedPass, true);
    assert.deepEqual(started, ["workspace_list", "workspace_read", "workspace_shell", "workspace_edit", "workspace_shell", "git_diff", "git_branch_create", "git_commit", "git_push"]);
    assert.match(await readFile(join(cwd, "math.mjs"), "utf8"), /a \+ b/);
    assert.equal(await readFile(join(cwd, "unrelated.txt"), "utf8"), "preserve me\n");
    await execFile(process.execPath, ["--test"], { cwd });
    const local = (await execFile("git", ["rev-parse", "feat/repair"], { cwd })).stdout.trim();
    const pushed = (await execFile("git", ["--git-dir", remote, "rev-parse", "refs/heads/feat/repair"])).stdout.trim();
    assert.equal(pushed, local);
    assert.match(session.getLastAssistantText() || "", /retested successfully/);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});
