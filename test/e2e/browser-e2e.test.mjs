import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { browserTools } from "../../src/browser/tools.mjs";
import { createSandoraSession } from "../../src/runtime/create-session.mjs";

const backendConfigured = Boolean(process.env.SANDORA_BROWSER_PATH || process.env.SANDORA_CDP_URL);
const tool = name => { const candidate = browserTools.find(item => item.name === name); return { ...candidate, execute: (id, args, signal, update, context) => candidate.execute(id, args, signal, update, { resourceOwnerId: `browser-e2e-${id}`, ...context }) }; };
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
    const duplicateClicks = await Promise.allSettled([
      tool("browser_click").execute("e2e", { sessionId, ref: shipRef }),
      tool("browser_click").execute("e2e", { sessionId, ref: shipRef }),
    ]);
    assert.equal(duplicateClicks.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(duplicateClicks.filter(result => result.status === "rejected" && /STALE_REF/.test(result.reason.message)).length, 1);
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

test("owned browser uploads a workspace file and retains a completed download safely", { skip: backendConfigured ? false : "set SANDORA_BROWSER_PATH or SANDORA_CDP_URL to run real browser E2E", timeout: 30_000 }, async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "sandora-browser-transfer-"));
  await writeFile(resolve(workspace, "upload.txt"), "UPLOAD_PAYLOAD");
  const server = createServer((request, response) => {
    if (request.url === "/download") { response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=sandora-download.txt" }); response.end("DOWNLOAD_PAYLOAD"); return; }
    if (request.url === "/z" || request.url === "/a") { const name = request.url.slice(1); response.writeHead(200, { "content-type": "text/plain", "content-disposition": `attachment; filename=${name}.txt` }); response.end(name.toUpperCase()); return; }
    response.writeHead(200, { "content-type": "text/html" }); response.end(`<title>Transfers</title><input type="file" aria-label="Upload"><a href="/download" download>Download</a><a href="/z" download>Z download</a><a href="/a" download>A download</a><p id="result">waiting</p><script>document.querySelector('input').addEventListener('change',e=>{const f=e.target.files[0];document.querySelector('#result').textContent=f.name+':'+f.size})</script>`);
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const previousUpload = process.env.SANDORA_ALLOW_BROWSER_UPLOAD, previousRetain = process.env.SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN;
  let sessionId;
  const context = { cwd: workspace, resourceOwnerId: "transfer-owner" };
  try {
    process.env.SANDORA_ALLOW_BROWSER_UPLOAD = "1"; process.env.SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN = "1";
    sessionId = value(await tool("browser_launch").execute("transfer", {}, undefined, undefined, context)).sessionId;
    await tool("browser_navigate").execute("transfer", { sessionId, url: `http://127.0.0.1:${server.address().port}/` }, undefined, undefined, context);
    await assert.rejects(() => tool("browser_observe").execute("transfer", { sessionId }, undefined, undefined, { ...context, resourceOwnerId: "other-owner" }), /different Sandora session/);
    let observed = value(await tool("browser_observe").execute("transfer", { sessionId }, undefined, undefined, context));
    await tool("browser_upload").execute("transfer", { sessionId, ref: observed.elements.find(element => element.text === "Upload").ref, path: "upload.txt" }, undefined, undefined, context);
    observed = value(await tool("browser_observe").execute("transfer", { sessionId }, undefined, undefined, context)); assert.match(observed.text, /upload\.txt:14/);
    await tool("browser_click").execute("transfer", { sessionId, ref: observed.elements.find(element => element.text === "Download").ref }, undefined, undefined, context);
    const downloaded = value(await tool("browser_download_wait").execute("transfer", { sessionId, timeoutMs: 10_000, retainPath: "artifacts/download.txt" }, undefined, undefined, context));
    assert.equal(downloaded.filename, "sandora-download.txt"); assert.match(downloaded.sha256, /^[a-f0-9]{64}$/); assert.equal(await readFile(resolve(workspace, "artifacts/download.txt"), "utf8"), "DOWNLOAD_PAYLOAD");
    observed = value(await tool("browser_observe").execute("transfer", { sessionId }, undefined, undefined, context));
    await tool("browser_click").execute("transfer", { sessionId, ref: observed.elements.find(element => element.text === "Z download").ref }, undefined, undefined, context);
    observed = value(await tool("browser_observe").execute("transfer", { sessionId }, undefined, undefined, context));
    await tool("browser_click").execute("transfer", { sessionId, ref: observed.elements.find(element => element.text === "A download").ref }, undefined, undefined, context);
    const [first, second] = (await Promise.all([
      tool("browser_download_wait").execute("transfer", { sessionId, timeoutMs: 10_000 }, undefined, undefined, context),
      tool("browser_download_wait").execute("transfer", { sessionId, timeoutMs: 10_000 }, undefined, undefined, context),
    ])).map(value);
    assert.equal(first.filename, "z.txt"); assert.equal(second.filename, "a.txt"); assert.notEqual(first.downloadId, second.downloadId);
  } finally {
    if (previousUpload === undefined) delete process.env.SANDORA_ALLOW_BROWSER_UPLOAD; else process.env.SANDORA_ALLOW_BROWSER_UPLOAD = previousUpload;
    if (previousRetain === undefined) delete process.env.SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN; else process.env.SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN = previousRetain;
    if (sessionId) await tool("browser_cleanup").execute("transfer", { sessionId }, undefined, undefined, context).catch(() => {});
    const closed = new Promise(resolveClose => server.close(resolveClose)); server.closeAllConnections(); await closed; await rm(workspace, { recursive: true, force: true });
  }
});

test("disposing a Sandora session cleans its owned browser sessions", { skip: backendConfigured ? false : "set SANDORA_BROWSER_PATH or SANDORA_CDP_URL to run real browser E2E", timeout: 30_000 }, async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "sandora-browser-owner-"));
  const provider = { model: "unused", async *stream() {} };
  const owner = await createSandoraSession({ core: "native", cwd: workspace, customTools: browserTools, provider, resourceOwnerId: "owner-a" });
  const peer = await createSandoraSession({ core: "native", cwd: workspace, customTools: browserTools, provider, resourceOwnerId: "owner-b" });
  const sessionId = value(await tool("browser_launch").execute("owner", {}, undefined, undefined, { resourceOwnerId: "owner-a" })).sessionId;
  const peerSessionId = value(await tool("browser_launch").execute("peer", {}, undefined, undefined, { resourceOwnerId: "owner-b" })).sessionId;
  try {
    await owner.dispose();
    await assert.rejects(() => tool("browser_observe").execute("owner", { sessionId }), /Unknown browser session/);
    await assert.rejects(() => tool("browser_observe").execute("peer", { sessionId: peerSessionId }, undefined, undefined, { resourceOwnerId: "owner-a" }), /different Sandora session/);
    assert.equal(value(await tool("browser_observe").execute("peer", { sessionId: peerSessionId }, undefined, undefined, { resourceOwnerId: "owner-b" })).url, "about:blank");
  } finally {
    await owner.dispose().catch(() => {});
    await peer.dispose().catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
});

test("real CDP navigation refuses an unauthorized cross-origin redirect", { skip: backendConfigured ? false : "set SANDORA_BROWSER_PATH or SANDORA_CDP_URL to run real browser E2E", timeout: 30_000 }, async () => {
  const destination = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<title>Redirect Destination</title><p>destination</p>"); });
  await new Promise((resolveListen, reject) => { destination.once("error", reject); destination.listen(0, "127.0.0.1", resolveListen); });
  const source = createServer((_request, response) => { response.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/final` }); response.end(); });
  await new Promise((resolveListen, reject) => { source.once("error", reject); source.listen(0, "127.0.0.1", resolveListen); });
  let sessionId;
  const previous = process.env.SANDORA_ALLOW_BROWSER_CROSS_ORIGIN;
  try {
    delete process.env.SANDORA_ALLOW_BROWSER_CROSS_ORIGIN;
    sessionId = value(await tool("browser_launch").execute("redirect", {})).sessionId;
    const requested = `http://127.0.0.1:${source.address().port}/redirect`;
    await assert.rejects(() => tool("browser_navigate").execute("redirect", { sessionId, url: requested }), /CROSS_ORIGIN_BLOCKED/);
    process.env.SANDORA_ALLOW_BROWSER_CROSS_ORIGIN = "1";
    const navigated = value(await tool("browser_navigate").execute("redirect", { sessionId, url: requested }));
    assert.equal(new URL(navigated.url).port, String(destination.address().port));
    assert.equal(value(await tool("browser_observe").execute("redirect", { sessionId })).title, "Redirect Destination");
    delete process.env.SANDORA_ALLOW_BROWSER_CROSS_ORIGIN;
    await assert.rejects(() => tool("browser_navigate").execute("redirect", { sessionId, url: requested }), /CROSS_ORIGIN_BLOCKED/);
  } finally {
    if (previous === undefined) delete process.env.SANDORA_ALLOW_BROWSER_CROSS_ORIGIN; else process.env.SANDORA_ALLOW_BROWSER_CROSS_ORIGIN = previous;
    if (sessionId) await tool("browser_cleanup").execute("redirect", { sessionId });
    for (const server of [source, destination]) { const closed = new Promise(resolveClose => server.close(resolveClose)); server.closeAllConnections(); await closed; }
  }
});

test("real CDP invalidates observed refs when the page navigates itself cross-origin", { skip: backendConfigured ? false : "set SANDORA_BROWSER_PATH or SANDORA_CDP_URL to run real browser E2E", timeout: 30_000 }, async () => {
  const destination = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<title>Other Origin</title><button type='button'>Same Shape</button>"); });
  await new Promise((resolveListen, reject) => { destination.once("error", reject); destination.listen(0, "127.0.0.1", resolveListen); });
  const source = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(`<title>Origin Source</title><button type='button'>Same Shape</button><script>setTimeout(()=>location.href='http://127.0.0.1:${destination.address().port}/other',500)</script>`); });
  await new Promise((resolveListen, reject) => { source.once("error", reject); source.listen(0, "127.0.0.1", resolveListen); });
  let sessionId;
  try {
    sessionId = value(await tool("browser_launch").execute("self-nav", {})).sessionId;
    await tool("browser_navigate").execute("self-nav", { sessionId, url: `http://127.0.0.1:${source.address().port}/` });
    const observed = value(await tool("browser_observe").execute("self-nav", { sessionId }));
    const ref = observed.elements.find(element => element.text === "Same Shape").ref;
    await new Promise(resolveWait => setTimeout(resolveWait, 900));
    await assert.rejects(() => tool("browser_click").execute("self-nav", { sessionId, ref }), /CROSS_ORIGIN_BLOCKED|STALE_REF/);
  } finally {
    if (sessionId) await tool("browser_cleanup").execute("self-nav", { sessionId });
    for (const server of [source, destination]) { const closed = new Promise(resolveClose => server.close(resolveClose)); server.closeAllConnections(); await closed; }
  }
});
