import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { browserTools } from "../src/browser-tools.mjs";

const backendConfigured = Boolean(process.env.SANDORA_BROWSER_PATH || process.env.SANDORA_CDP_URL);
const tool = name => browserTools.find(candidate => candidate.name === name);
const value = result => JSON.parse(result.content[0].text);

test("real CDP flow observes structured content before screenshot and cleans up", { skip: backendConfigured ? false : "set SANDORA_BROWSER_PATH or SANDORA_CDP_URL to run real browser E2E", timeout: 30_000 }, async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "sandora-browser-e2e-"));
  let sessionId;
  try {
    sessionId = value(await tool("browser_launch").execute("e2e", {})).sessionId;
    const html = "<title>Sandora E2E</title><button aria-label='Ship'>Go</button><p>structured observation</p>";
    await tool("browser_navigate").execute("e2e", { sessionId, url: `data:text/html,${encodeURIComponent(html)}` });
    let observed;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      observed = value(await tool("browser_observe").execute("e2e", { sessionId }));
      if (observed.title === "Sandora E2E") break;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    assert.equal(observed.title, "Sandora E2E");
    assert.match(observed.text, /structured observation/);
    assert.deepEqual(observed.elements.map(element => element.text), ["Go"]);

    await tool("browser_screenshot").execute("e2e", { sessionId, path: "artifacts/page.png" }, undefined, undefined, { cwd: workspace });
    assert.ok((await readFile(resolve(workspace, "artifacts/page.png"))).length > 100);
  } finally {
    if (sessionId) await tool("browser_cleanup").execute("e2e", { sessionId });
    await rm(workspace, { recursive: true, force: true });
  }
});
