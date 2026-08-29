import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAgentSession } from "../../src/runtime/pi-agent-session.mjs";
import { createCodingTools } from "../../src/tools/coding-tools.mjs";

const enabled = process.env.SANDORA_PI_E2E === "1";

test("real Pi manager delegates bounded parallel read-only work and synthesizes results", { skip: enabled ? false : "set SANDORA_PI_E2E=1 with Pi credentials to run delegation E2E", timeout: 240_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sandora-subagents-e2e-"));
  let session;
  try {
    await writeFile(join(cwd, "alpha.txt"), "ALPHA_TOKEN_4M2\n");
    await writeFile(join(cwd, "beta.txt"), "BETA_TOKEN_8K6\n");
    session = await createPiAgentSession({ cwd, customTools: createCodingTools(), systemPrompt: "You are a delegation test manager. Follow delegation instructions exactly and synthesize worker evidence." });
    const started = [];
    session.subscribe(event => { if (event.type === "tool.start") started.push(event.name); });
    await session.prompt("You must call delegate_subagents exactly once with two independent tasks in the same call: worker 1 reads alpha.txt and reports its exact token; worker 2 reads beta.txt and reports its exact token. Then synthesize both exact tokens in your final answer.");
    assert.equal(started.filter(name => name === "delegate_subagents").length, 1);
    const answer = session.getLastAssistantText() || "";
    assert.match(answer, /ALPHA_TOKEN_4M2/);
    assert.match(answer, /BETA_TOKEN_8K6/);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
