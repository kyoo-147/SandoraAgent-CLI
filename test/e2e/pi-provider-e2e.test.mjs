import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAgentSession } from "../../src/runtime/pi-agent-session.mjs";
import { createCodingTools } from "../../src/tools/coding-tools.mjs";

const enabled = process.env.SANDORA_PI_E2E === "1";

test("real Pi provider uses confined tools, resumes context, reports usage, and aborts", { skip: enabled ? false : "set SANDORA_PI_E2E=1 with Pi credentials to run provider E2E", timeout: 180_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sandora-pi-e2e-"));
  let session;
  try {
    await writeFile(join(cwd, "evidence.txt"), "SANDORA_E2E_TOKEN_7Q9\n", "utf8");
    session = await createPiAgentSession({ cwd, customTools: createCodingTools(), systemPrompt: "You are a test agent. Follow tool-use instructions exactly and answer concisely." });
    const firstId = session.sessionId;
    const events = [];
    session.subscribe(event => events.push(event));
    await session.prompt("Use workspace_read on evidence.txt. Then reply with only the exact token found in that file.");
    assert.match(session.getLastAssistantText() || "", /SANDORA_E2E_TOKEN_7Q9/);
    assert.ok(events.some(event => event.type === "tool.start" && event.name === "workspace_read"));
    assert.ok((session.getContextUsage()?.tokens || 0) > 0);
    session.dispose();

    session = await createPiAgentSession({ cwd, customTools: createCodingTools(), systemPrompt: "You are a test agent. Answer concisely." });
    assert.equal(session.sessionId, firstId);
    await session.prompt("What exact token did you read in the previous turn? Reply with only the token.");
    assert.match(session.getLastAssistantText() || "", /SANDORA_E2E_TOKEN_7Q9/);

    const pending = session.prompt("Think silently for a long time before replying.");
    await new Promise(resolve => setTimeout(resolve, 25));
    await session.abort();
    await Promise.race([pending.catch(() => undefined), new Promise((_, reject) => setTimeout(() => reject(new Error("Pi abort did not settle")), 10_000))]);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
