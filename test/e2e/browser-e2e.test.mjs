import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { browserTools } from "../../src/browser/tools.mjs";

const backendConfigured = Boolean(process.env.SANDORA_BROWSER_PATH || process.env.SANDORA_CDP_URL);
const tool = name => browserTools.find(candidate => candidate.name === name);
const value = result => JSON.parse(result.content[0].text);

test("real CDP flow observes structured content before screenshot and cleans up", { skip: backendConfigured ? false : "set SANDORA_BROWSER_PATH or SANDORA_CDP_URL to run real browser E2E", timeout: 30_000 }, async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "sandora-browser-e2e-"));
  const html = "<title>Sandora E2E</title><input id='name' aria-label='Name'><button id='ship' type='button' aria-label='Ship' onclick=\"document.querySelector('p').textContent='submitted '+document.querySelector('#name').value\">Go</button><button type='submit'>Send</button><p>structured observation</p>";
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(html); });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  let sessionId;
  try {
    sessionId = value(await tool("browser_launch").execute("e2e", {})).sessionId;
    const address = server.address();
    await tool("browser_navigate").execute("e2e", { sessionId, url: `http://127.0.0.1:${address.port}/` });
    let observed;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      observed = value(await tool("browser_observe").execute("e2e", { sessionId }));
      if (observed.title === "Sandora E2E") break;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    assert.equal(observed.title, "Sandora E2E");
    assert.match(observed.text, /structured observation/);
    assert.deepEqual(observed.elements.map(element => element.text), ["Name", "Go", "Send"]);
    const nameRef = observed.elements.find(element => element.text === "Name").ref;
    await tool("browser_type").execute("e2e", { sessionId, ref: nameRef, text: "Sandora" });
    await assert.rejects(() => tool("browser_click").execute("e2e", { sessionId, ref: nameRef }), /STALE_REF/);
    observed = value(await tool("browser_observe").execute("e2e", { sessionId }));
    const sendRef = observed.elements.find(element => element.text === "Send").ref;
    await assert.rejects(() => tool("browser_click").execute("e2e", { sessionId, ref: sendRef }), /consequential action blocked/);
    const shipRef = observed.elements.find(element => element.text === "Go").ref;
    await tool("browser_click").execute("e2e", { sessionId, ref: shipRef });
    observed = value(await tool("browser_observe").execute("e2e", { sessionId }));
    assert.match(observed.text, /submitted Sandora/);

    await tool("browser_screenshot").execute("e2e", { sessionId, path: "artifacts/page.png" }, undefined, undefined, { cwd: workspace });
    assert.ok((await readFile(resolve(workspace, "artifacts/page.png"))).length > 100);
  } finally {
    if (sessionId) await tool("browser_cleanup").execute("e2e", { sessionId });
    const closed = new Promise(resolveClose => server.close(resolveClose));
    server.closeAllConnections();
    await closed;
    await rm(workspace, { recursive: true, force: true });
  }
});
