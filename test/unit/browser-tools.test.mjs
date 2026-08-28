import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { allowedCdpWebSocket, browserTools, resolveBrowserArtifactPath } from "../../src/browser/tools.mjs";

test("browser and computer contracts are registered", () => {
  const names = browserTools.map(tool => tool.name);
  assert.deepEqual(names, [
    "browser_launch", "browser_connect", "browser_observe", "browser_navigate",
    "browser_click", "browser_type", "browser_scroll", "browser_tabs",
    "browser_screenshot", "browser_cleanup", "computer_observe", "computer_focus",
    "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_screenshot",
  ]);
});

test("computer tools fail closed with an explicit capability response", async () => {
  const tool = browserTools.find(candidate => candidate.name === "computer_observe");
  const result = await tool.execute("test", {});
  assert.equal(result.details.supported, false);
  assert.match(result.content[0].text, /supported/);
});

test("browser artifact paths stay inside the runtime workspace", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sandora-browser-artifact-"));
  try {
    assert.equal(await resolveBrowserArtifactPath(root, "artifacts/page.png"), resolve(root, "artifacts/page.png"));
    await assert.rejects(() => resolveBrowserArtifactPath(root, "../outside.png"), /inside the workspace/);
    await assert.rejects(() => resolveBrowserArtifactPath(undefined, "page.png"), /requires a workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser endpoint policy rejects remote CDP without explicit authority", async () => {
  const connect = browserTools.find(candidate => candidate.name === "browser_connect");
  await assert.rejects(() => connect.execute("test", { endpoint: "https://example.com:9222" }), /SANDORA_ALLOW_REMOTE_CDP/);
  await assert.rejects(() => connect.execute("test", { endpoint: "file:///tmp/cdp" }), /HTTP or HTTPS/);
});

test("CDP target WebSockets remain pinned to the authorized discovery endpoint", () => {
  assert.equal(allowedCdpWebSocket("http://127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/page/one"), "ws://127.0.0.1:9222/devtools/page/one");
  assert.equal(allowedCdpWebSocket("https://127.0.0.1:443", "wss://127.0.0.1:443/devtools/page/one"), "wss://127.0.0.1/devtools/page/one");
  assert.throws(() => allowedCdpWebSocket("http://127.0.0.1:9222", "ws://example.com:9222/devtools/page/one"), /host and port/);
  assert.throws(() => allowedCdpWebSocket("http://127.0.0.1:9222", "wss://127.0.0.1:9222/devtools/page/one"), /transport/);
  assert.throws(() => allowedCdpWebSocket("http://127.0.0.1:9222", "ws://user:pass@127.0.0.1:9222/devtools/page/one"), /credentials/);
});
