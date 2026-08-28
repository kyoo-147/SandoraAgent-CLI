import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { allowedCdpWebSocket, browserTools, resolveBrowserArtifactPath, writeBrowserArtifact } from "../../src/browser/tools.mjs";

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

test("existing browser profiles require separate explicit authority", async () => {
  const connect = browserTools.find(tool => tool.name === "browser_connect");
  const previous = process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE;
  try { delete process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE; await assert.rejects(() => connect.execute("test", { endpoint: "http://127.0.0.1:1" }), /EXISTING_BROWSER_PROFILE/); }
  finally { if (previous === undefined) delete process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE; else process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE = previous; }
});

test("HTTPS CDP discovery uses an HTTPS client instead of rejecting the protocol", async () => {
  const connect = browserTools.find(tool => tool.name === "browser_connect");
  const previous = process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE;
  try { process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE = "1"; await assert.rejects(() => connect.execute("test", { endpoint: "https://127.0.0.1:1" }), error => error?.code !== "ERR_INVALID_PROTOCOL"); }
  finally { if (previous === undefined) delete process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE; else process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE = previous; }
});

test("CDP target WebSockets remain pinned to the authorized discovery endpoint", () => {
  assert.equal(allowedCdpWebSocket("http://127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/page/one"), "ws://127.0.0.1:9222/devtools/page/one");
  assert.equal(allowedCdpWebSocket("https://127.0.0.1:443", "wss://127.0.0.1:443/devtools/page/one"), "wss://127.0.0.1/devtools/page/one");
  assert.throws(() => allowedCdpWebSocket("http://127.0.0.1:9222", "ws://example.com:9222/devtools/page/one"), /host and port/);
  assert.throws(() => allowedCdpWebSocket("http://127.0.0.1:9222", "wss://127.0.0.1:9222/devtools/page/one"), /transport/);
  assert.throws(() => allowedCdpWebSocket("http://127.0.0.1:9222", "ws://user:pass@127.0.0.1:9222/devtools/page/one"), /credentials/);
});

test("browser artifact creation is exclusive and rejects symlink or junction entries", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sandora-browser-secure-"));
  const outside = await mkdtemp(resolve(tmpdir(), "sandora-browser-outside-"));
  try {
    await writeBrowserArtifact(root, "artifacts/new.bin", Buffer.from("first"));
    assert.equal(await readFile(resolve(root, "artifacts/new.bin"), "utf8"), "first");
    assert.equal((await stat(resolve(root, "artifacts/new.bin"))).isFile(), true);
    await assert.rejects(() => writeBrowserArtifact(root, "artifacts/new.bin", Buffer.from("second")), /EEXIST/);
    assert.equal(await readFile(resolve(root, "artifacts/new.bin"), "utf8"), "first");

    await writeFile(resolve(outside, "protected.bin"), "protected");
    if (process.platform !== "win32") {
      await symlink(resolve(outside, "protected.bin"), resolve(root, "final-link.bin"), "file");
      await assert.rejects(() => writeBrowserArtifact(root, "final-link.bin", Buffer.from("changed")), /outside|EEXIST/);
      assert.equal(await readFile(resolve(outside, "protected.bin"), "utf8"), "protected");
    }

    const physical = resolve(root, "physical");
    await writeBrowserArtifact(root, "physical/seed.bin", Buffer.from("seed"));
    await symlink(physical, resolve(root, "linked-parent"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => writeBrowserArtifact(root, "linked-parent/escaped.bin", Buffer.from("blocked")), /physical workspace directory|symlinks|junctions/);
    await assert.rejects(() => stat(resolve(physical, "escaped.bin")), /ENOENT/);
    if (process.platform === "win32") {
      await symlink(outside, resolve(root, "outside-junction"), "junction");
      await assert.rejects(() => writeBrowserArtifact(root, "outside-junction/page.bin", Buffer.from("blocked")), /physical workspace directory|symlinks|junctions|inside/);
      await assert.rejects(() => stat(resolve(outside, "page.bin")), /ENOENT/);
    }
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
