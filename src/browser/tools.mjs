import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { defineTool } from "../tools/registry.mjs";
import { filteredEnvironment } from "../tools/coding-tools.mjs";

const sessions = new Map();
const MAX_BROWSER_TRANSFER_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_WAIT_MS = 30_000;

export async function resolveWorkspaceRegularFile(cwd, value) {
  if (!cwd || !value || typeof value !== "string" || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) throw new Error("Browser upload requires a workspace-relative path");
  const root = await realpath(cwd); const candidate = resolve(root, value); assertInside(root, candidate);
  const physical = await realpath(candidate); assertInside(root, physical);
  const info = await lstat(candidate); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Browser upload requires an existing regular file without symlink or junction escape");
  const physicalInfo = await stat(physical); if (!physicalInfo.isFile() || physicalInfo.size > MAX_BROWSER_TRANSFER_BYTES) throw new Error("Browser upload file is not regular or exceeds 50 MB");
  return { path: physical, size: physicalInfo.size };
}
let nextId = 1;

function assertInside(root, candidate) {
  const distance = relative(root, candidate);
  if (distance === ".." || distance.startsWith(`..${sep}`) || distance.startsWith(sep)) throw new Error("Browser artifact path must remain inside the workspace");
}

export async function resolveBrowserArtifactPath(cwd, value) {
  if (!cwd || !value) throw new Error("Browser screenshot path requires a workspace and relative path");
  const root = await realpath(cwd);
  const candidate = resolve(root, value);
  assertInside(root, candidate);
  try {
    const existing = await realpath(candidate);
    assertInside(root, existing);
    return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const parentRelative = relative(root, dirname(candidate));
  let parent = root;
  for (const component of parentRelative.split(sep).filter(Boolean)) {
    parent = join(parent, component);
    let info;
    try { info = await lstat(parent); }
    catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(parent); info = await lstat(parent); }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Browser artifact parent must be a physical workspace directory without symlinks or junctions");
    assertInside(root, await realpath(parent));
  }
  return candidate;
}

async function validateArtifactParent(cwd, candidate) {
  const root = await realpath(cwd);
  let parent = root;
  for (const component of relative(root, dirname(candidate)).split(sep).filter(Boolean)) {
    parent = join(parent, component);
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Browser artifact parent must remain a physical workspace directory");
    assertInside(root, await realpath(parent));
  }
}

export async function writeBrowserArtifact(cwd, value, data) {
  const artifactPath = await resolveBrowserArtifactPath(cwd, value);
  await validateArtifactParent(cwd, artifactPath);
  const handle = await open(artifactPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Browser artifact destination is not a regular file");
    await handle.writeFile(data);
  } finally { await handle.close(); }
  return artifactPath;
}

function text(value, details = {}) { return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details }; }
function unsupported(operation) { return text({ supported: false, operation, reason: "Computer control is unavailable on this platform or no Windows adapter is installed." }, { supported: false }); }
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function stopProcess(child) {
  if (!child) return;
  const closed = new Promise(resolveClose => child.once("close", resolveClose));
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    await Promise.race([new Promise(resolveKiller => { killer.once("close", resolveKiller); killer.once("error", resolveKiller); }), delay(2_000)]);
    if (child.exitCode !== null || child.signalCode) return;
  } else if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
  await Promise.race([closed, delay(2_000)]);
  if (child.exitCode === null && !child.signalCode) {
    child.kill("SIGKILL");
    await Promise.race([closed, delay(1_000)]);
  }
}
function isLoopback(hostname) { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase()); }
function allowedCdpEndpoint(endpoint) {
  const value = new URL(endpoint);
  if (!["http:", "https:"].includes(value.protocol)) throw new Error("CDP endpoint must use HTTP or HTTPS");
  if (!isLoopback(value.hostname) && process.env.SANDORA_ALLOW_REMOTE_CDP !== "1") throw new Error("Remote CDP endpoints require SANDORA_ALLOW_REMOTE_CDP=1 explicit authority");
  return value.href;
}
export function allowedCdpWebSocket(endpoint, webSocketUrl) {
  const base = new URL(allowedCdpEndpoint(endpoint));
  const target = new URL(webSocketUrl);
  const expectedProtocol = base.protocol === "https:" ? "wss:" : "ws:";
  if (target.protocol !== expectedProtocol || target.username || target.password) throw new Error("CDP target WebSocket must use the authorized endpoint transport without credentials");
  if (target.hostname.toLowerCase() !== base.hostname.toLowerCase() || target.port !== base.port) throw new Error("CDP target WebSocket must remain on the authorized endpoint host and port");
  return target.href;
}
function crossOriginAllowed() { return process.env.SANDORA_ALLOW_BROWSER_CROSS_ORIGIN === "1"; }
function assertAllowedOrigin(expectedOrigin, actualUrl) {
  const actual = new URL(actualUrl);
  if (expectedOrigin && actual.origin !== expectedOrigin && !crossOriginAllowed()) throw new Error(`CROSS_ORIGIN_BLOCKED: expected ${expectedOrigin}, received ${actual.origin}; set SANDORA_ALLOW_BROWSER_CROSS_ORIGIN=1 with explicit authority`);
  return actual.href;
}
async function settledLocation(page, signal) {
  let last = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new Error("Browser action cancelled");
    try {
      const state = await page.evaluate(`({url:location.href,ready:document.readyState})`, true, signal);
      last = state.url;
      if (state.ready === "complete") return state.url;
    } catch { /* navigation may replace the execution context */ }
    await delay(100);
  }
  if (last) return last;
  throw new Error("Browser navigation did not expose a final location");
}
async function navigateWithOriginPolicy(value, requestedUrl, signal) {
  const requested = new URL(requestedUrl);
  const expectedOrigin = value.allowedOrigin || requested.origin;
  assertAllowedOrigin(expectedOrigin, requested.href);
  clearBrowserRefs(value);
  await value.page.call("Page.navigate", { url: requested.href }, signal);
  const finalUrl = await settledLocation(value.page, signal);
  try { assertAllowedOrigin(expectedOrigin, finalUrl); }
  catch (error) { clearBrowserRefs(value); await value.page.call("Page.navigate", { url: "about:blank" }, signal).catch(() => {}); value.allowedOrigin = null; throw error; }
  value.allowedOrigin = new URL(finalUrl).origin;
  return finalUrl;
}
function allowedNavigation(url) {
  const value = new URL(url);
  if (!["http:", "https:"].includes(value.protocol) || value.username || value.password) throw new Error("Browser navigation requires an HTTP(S) URL without embedded credentials");
  return value.href;
}
async function browserExecutable() {
  const configured = process.env.SANDORA_BROWSER_PATH;
  if (!configured) return process.platform === "win32" ? "chrome.exe" : "chromium";
  const executable = await realpath(configured);
  const info = await stat(executable);
  if (!info.isFile() || !/^(chrome|chromium|msedge)(\.exe)?$/i.test(basename(executable))) throw new Error("SANDORA_BROWSER_PATH must be a regular Chrome, Chromium, or Edge executable");
  return executable;
}
function json(url, method = "GET", signal) {
  return new Promise((resolvePromise, reject) => {
    const req = (new URL(url).protocol === "https:" ? httpsRequest : httpRequest)(url, { method }, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
      response.on("end", () => { try { const value = JSON.parse(body); response.statusCode >= 400 ? reject(new Error(`CDP HTTP ${response.statusCode}`)) : resolvePromise(value); } catch (error) { reject(error); } });
    });
    const abort = () => req.destroy(signal.reason || new Error("Browser request cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    req.on("error", reject); req.on("close", () => signal?.removeEventListener("abort", abort)); req.end();
  });
}

class CdpPage {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.pending = new Map(); this.listeners = new Map(); this.id = 0; }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    try { await new Promise((resolvePromise, reject) => { this.ws.addEventListener("open", resolvePromise, { once: true }); this.ws.addEventListener("error", reject, { once: true }); }); }
    catch (error) { this.close(); throw error; }
    this.ws.addEventListener("message", event => { let message; try { message = JSON.parse(event.data); } catch { this.close(); return; } if (message.id && this.pending.has(message.id)) { const pending = this.pending.get(message.id); this.pending.delete(message.id); pending.cleanup?.(); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); } else if (message.method) { for (const listener of this.listeners.get(message.method) || []) listener(message.params); } });
    this.ws.addEventListener("close", () => { for (const pending of this.pending.values()) { pending.cleanup?.(); pending.reject(new Error("CDP connection closed")); } this.pending.clear(); });
    try { await this.call("Page.enable"); await this.call("Runtime.enable"); await this.call("DOM.enable"); return this; }
    catch (error) { this.close(); throw error; }
  }
  call(method, params = {}, signal) { return new Promise((resolvePromise, reject) => { if (signal?.aborted) return reject(signal.reason || new Error("Browser action cancelled")); const id = ++this.id; const abort = () => { this.pending.delete(id); reject(signal.reason || new Error("Browser action cancelled")); }; const cleanup = () => signal?.removeEventListener("abort", abort); signal?.addEventListener("abort", abort, { once: true }); this.pending.set(id, { resolve: resolvePromise, reject, cleanup }); try { this.ws.send(JSON.stringify({ id, method, params })); } catch (error) { this.pending.delete(id); cleanup(); reject(error); } }); }
  async evaluate(expression, returnByValue = true, signal) { const result = await this.call("Runtime.evaluate", { expression, returnByValue, awaitPromise: true }, signal); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed"); return result.result?.value; }
  on(method, listener) { if (!this.listeners.has(method)) this.listeners.set(method, new Set()); this.listeners.get(method).add(listener); return () => this.listeners.get(method)?.delete(listener); }
  close() { if (this.ws) this.ws.close(); for (const pending of this.pending.values()) { pending.cleanup?.(); pending.reject(new Error("CDP connection closed")); } this.pending.clear(); this.listeners.clear(); this.ws = null; }
}

function bindPage(value) {
  value.page.on("Page.frameNavigated", ({ frame }) => { if (!frame.parentId) clearBrowserRefs(value); });
  value.page.on("Browser.downloadWillBegin", event => value.downloads.set(event.guid, { guid: event.guid, filename: event.suggestedFilename, sequence: ++value.downloadSequence, state: "IN_PROGRESS" }));
  value.page.on("Browser.downloadProgress", event => { const record = value.downloads.get(event.guid); if (record) Object.assign(record, { state: String(event.state || "IN_PROGRESS").toUpperCase(), receivedBytes: event.receivedBytes, totalBytes: event.totalBytes }); });
}
async function assertCurrentPageOrigin(value, signal) {
  const url = await value.page.evaluate("location.href", true, signal);
  assertAllowedOrigin(value.allowedOrigin, url);
  return url;
}

async function connect(endpoint, { ownedLaunch = false, ownerId = null } = {}) {
  if (typeof ownerId !== "string" || !ownerId) throw new Error("Browser resource owner identity is required");
  const base = allowedCdpEndpoint(endpoint || process.env.SANDORA_CDP_URL || "http://127.0.0.1:9222");
  if (!ownedLaunch && process.env.SANDORA_ALLOW_EXISTING_BROWSER_PROFILE !== "1") throw new Error("Connecting to an existing browser profile requires SANDORA_ALLOW_EXISTING_BROWSER_PROFILE=1 explicit authority");
  const targets = await json(new URL("/json/list", base).href);
  const target = targets.find(candidate => candidate.type === "page" && candidate.webSocketDebuggerUrl);
  if (!target) throw new Error("CDP endpoint did not provide a page target");
  const page = await new CdpPage(allowedCdpWebSocket(base, target.webSocketDebuggerUrl)).connect();
  const uploadDir = await mkdtemp(join(tmpdir(), "sandora-uploads-"));
  const initialOrigin = /^https?:/i.test(target.url || "") ? new URL(target.url).origin : null;
  const id = String(nextId++); const value = { page, process: null, endpoint: base, allowedOrigin: initialOrigin, targetId: target.id, ownerId, profileMode: ownedLaunch ? "anonymous-ephemeral" : "authorized-existing", ownedLaunch, uploadDir, uploadSnapshots: new Set(), consumedDownloads: new Set(), downloads: new Map(), downloadSequence: 0 }; sessions.set(id, value); bindPage(value); return { id, page, profileMode: value.profileMode };
}

async function launch(endpoint, ownerId) {
  if (typeof ownerId !== "string" || !ownerId) throw new Error("Browser resource owner identity is required");
  if (endpoint || process.env.SANDORA_CDP_URL) return connect(endpoint, { ownerId });
  const executable = await browserExecutable();
  const port = 9222 + Math.floor(Math.random() * 500);
  const profileDir = await mkdtemp(join(tmpdir(), "sandora-browser-"));
  const downloadDir = await mkdtemp(join(tmpdir(), "sandora-downloads-"));
  const child = spawn(executable, [`--headless=new`, `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { env: filteredEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const base = `http://127.0.0.1:${port}`;
  let lastError = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    let result;
    try { result = await connect(base, { ownedLaunch: true, ownerId }); const value = sessions.get(result.id); Object.assign(value, { process: child, profileDir, downloadDir }); await value.page.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true }); return result; }
    catch (error) { lastError = error.message; if (result) { const value = sessions.get(result.id); value?.page.close(); if (value?.uploadDir) await rm(value.uploadDir, { recursive: true, force: true }); sessions.delete(result.id); break; } await delay(100); }
  }
  await stopProcess(child); await rm(profileDir, { recursive: true, force: true }); await rm(downloadDir, { recursive: true, force: true }); throw new Error(`Unable to launch/connect browser: ${lastError}`);
}

async function createUploadSnapshot(value, data, filename) {
  if (!value.uploadDir) throw new Error("Browser upload staging is unavailable");
  const directory = join(value.uploadDir, randomUUID()); await mkdir(directory, { mode: 0o700 });
  const path = join(directory, basename(filename));
  const handle = await open(path, "wx", 0o400);
  try { await handle.writeFile(data); await handle.sync(); }
  catch (error) { await handle.close().catch(() => {}); await rm(path, { force: true }); throw error; }
  await handle.close(); value.uploadSnapshots.add(path); return path;
}

const browserLaunch = defineTool({ name: "browser_launch", label: "Browser launch", description: "Launch an isolated anonymous headless Chromium browser, or connect to an explicitly authorized existing CDP profile.", parameters: Type.Object({ endpoint: Type.Optional(Type.String()) }), execute: async (_id, params, _signal, _update, context) => { const result = await launch(params.endpoint, context?.resourceOwnerId); return text({ sessionId: result.id, connected: true, profileMode: result.profileMode }); } });
const browserConnect = defineTool({ name: "browser_connect", label: "Browser connect", description: "Connect to an existing Chrome DevTools Protocol profile only with explicit existing-profile authority.", parameters: Type.Object({ endpoint: Type.String() }), execute: async (_id, params, _signal, _update, context) => { const result = await connect(params.endpoint, { ownerId: context?.resourceOwnerId }); return text({ sessionId: result.id, connected: true, profileMode: result.profileMode }); } });
function session(params, context) { const value = sessions.get(params.sessionId); if (!value) throw new Error("Unknown browser session"); if (value.ownerId && context?.resourceOwnerId !== value.ownerId) throw new Error("Browser session belongs to a different Sandora session"); return value; }
function clearBrowserRefs(value) { value.observationGeneration = (value.observationGeneration || 0) + 1; value.refs = new Map(); }
function elementSignature(element) { return JSON.stringify({ tag: element.tag, role: element.role, text: element.text, type: element.type, name: element.name, href: element.href || null }); }
function consumeElementRef(value, params) {
  if (!params.ref) throw new Error("A fresh browser_observe element ref is required");
  const record = value.refs?.get(params.ref);
  if (!record || record.generation !== value.observationGeneration) throw new Error("STALE_REF: observe the page again before acting");
  value.refs.delete(params.ref);
  return record;
}
function assertConsequentialAction(record) {
  const destructive = /^(submit|image)$/i.test(record.element.type || "") || /(submit|send|buy|pay|delete|remove|confirm|ship)/i.test(record.element.text || "");
  if (destructive && process.env.SANDORA_ALLOW_BROWSER_SUBMIT !== "1") throw new Error("Browser consequential action blocked; set SANDORA_ALLOW_BROWSER_SUBMIT=1 with explicit authority");
}
const browserObserve = defineTool({ name: "browser_observe", label: "Browser observe", description: "Return structured URL, title, text, and short-lived opaque refs for interactive elements.", parameters: Type.Object({ sessionId: Type.String() }), execute: async (_id, params, signal, _update, context) => { const value = session(params, context); const observed = await value.page.evaluate(`({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,12000),elements:[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].slice(0,200).map((e,i)=>({index:i,tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),text:(e.innerText||e.value||e.getAttribute('aria-label')||'').trim().slice(0,300),type:e.getAttribute('type'),name:e.getAttribute('name'),href:e.href||null,disabled:!!e.disabled}))})`, true, signal); if (!value.allowedOrigin && /^https?:/i.test(observed.url)) value.allowedOrigin = new URL(observed.url).origin; assertAllowedOrigin(value.allowedOrigin, observed.url); clearBrowserRefs(value); observed.elements = observed.elements.map(element => { const ref = `b${params.sessionId}-g${value.observationGeneration}-e${element.index}`; value.refs.set(ref, { generation: value.observationGeneration, index: element.index, signature: elementSignature(element), element }); return { ...element, ref, index: undefined }; }); return text(observed, { observationGeneration: value.observationGeneration }); } });
const browserUpload = defineTool({ name: "browser_upload", label: "Browser upload", description: "Upload an existing workspace file to a fresh observed input[type=file] ref using CDP DOM methods.", parameters: Type.Object({ sessionId: Type.String(), ref: Type.String(), path: Type.String() }), execute: async (_id, p, signal, _update, context) => { if (process.env.SANDORA_ALLOW_BROWSER_UPLOAD !== "1") throw new Error("Browser upload blocked; set SANDORA_ALLOW_BROWSER_UPLOAD=1 with explicit authority"); const value = session(p, context); await assertCurrentPageOrigin(value, signal); const record = consumeElementRef(value, p); if (record.element.tag !== "input" || String(record.element.type).toLowerCase() !== "file") throw new Error("Browser upload ref must resolve to input[type=file]"); const file = await resolveWorkspaceRegularFile(context?.cwd, p.path); const signatureValid = await value.page.evaluate(`(()=>{const e=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')][${record.index}];if(!e)return false;return JSON.stringify({tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),text:(e.innerText||e.value||e.getAttribute('aria-label')||'').trim().slice(0,300),type:e.getAttribute('type'),name:e.getAttribute('name'),href:e.href||null})===${JSON.stringify(record.signature)}})()`, true, signal); if (!signatureValid) throw new Error("STALE_REF: observed file input changed"); const document = await value.page.call("DOM.getDocument", { depth: -1 }, signal); const nodes = await value.page.call("DOM.querySelectorAll", { nodeId: document.root.nodeId, selector: 'a,button,input,textarea,select,[role="button"]' }, signal); const nodeId = nodes.nodeIds[record.index]; if (!nodeId) throw new Error("STALE_REF: observed file input no longer exists"); const revalidated = await resolveWorkspaceRegularFile(context?.cwd, p.path); if (revalidated.path !== file.path || revalidated.size !== file.size) throw new Error("Browser upload file changed during validation"); const data = await readFile(revalidated.path); if (data.length !== revalidated.size || data.length > MAX_BROWSER_TRANSFER_BYTES) throw new Error("Browser upload file changed during snapshot"); const sha256 = createHash("sha256").update(data).digest("hex"); const snapshot = await createUploadSnapshot(value, data, basename(revalidated.path)); await value.page.call("DOM.setFileInputFiles", { nodeId, files: [snapshot] }, signal); clearBrowserRefs(value); return text({ uploaded: true, path: p.path, size: data.length, sha256 }); } });
const browserDownloadWait = defineTool({ name: "browser_download_wait", label: "Browser download wait", description: "Wait for the next unconsumed completed download from an owned anonymous browser and return its hash without content.", parameters: Type.Object({ sessionId: Type.String(), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: DOWNLOAD_WAIT_MS })), retainPath: Type.Optional(Type.String()) }), execute: async (_id, p, signal, _update, context) => { const value = session(p, context); if (!value.ownedLaunch || !value.downloadDir) throw new Error("Browser downloads require an owned anonymous browser session"); if (p.retainPath && process.env.SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN !== "1") throw new Error("Download retention blocked; set SANDORA_ALLOW_BROWSER_DOWNLOAD_RETAIN=1 with explicit authority"); const deadline = Date.now() + (p.timeoutMs || DOWNLOAD_WAIT_MS); let download; while (Date.now() < deadline) { if (signal?.aborted) throw signal.reason || new Error("Browser download cancelled"); download = [...value.downloads.values()].filter(record => !value.consumedDownloads.has(record.guid)).sort((a, b) => a.sequence - b.sequence)[0]; if (download?.state === "CANCELED") { value.consumedDownloads.add(download.guid); throw new Error("Browser download was cancelled"); } if (download?.state === "COMPLETED") { value.consumedDownloads.add(download.guid); break; } download = null; await delay(100); } if (!download) throw new Error("Browser download timed out or remained partial"); const candidate = download.filename; if (!candidate || basename(candidate) !== candidate || candidate.includes("..") || candidate.includes("/") || candidate.includes("\\")) { value.consumedDownloads.add(download.guid); throw new Error("Browser download filename was unsafe"); } const downloaded = join(value.downloadDir, candidate); const info = await lstat(downloaded); value.consumedDownloads.add(download.guid); if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BROWSER_TRANSFER_BYTES) throw new Error("Browser download is not a bounded regular file"); const data = await readFile(downloaded); const sha256 = createHash("sha256").update(data).digest("hex"); let retained = null; if (p.retainPath) { await writeBrowserArtifact(context?.cwd, p.retainPath, data); retained = p.retainPath; } return text({ downloaded: true, downloadId: download.guid, filename: candidate, size: info.size, sha256, retained }); } });
const browserNavigate = defineTool({ name: "browser_navigate", label: "Browser navigate", description: "Navigate the current browser page to an HTTP(S) URL without embedded credentials, invalidating prior element refs.", parameters: Type.Object({ sessionId: Type.String(), url: Type.String() }), execute: async (_id, params, signal, _update, context) => { const value = session(params, context); const url = allowedNavigation(params.url); const finalUrl = await navigateWithOriginPolicy(value, url, signal); return text({ url: finalUrl, requestedUrl: url }); } });
const browserAction = (name, description, action, properties) => defineTool({ name, label: name, description, parameters: Type.Object({ sessionId: Type.String(), ...properties }), execute: async (_id, params, signal, _update, context) => { if (signal?.aborted) throw new Error("Browser action cancelled"); const value = session(params, context); return text(await action(value.page, params, context, signal, value)); } });
const browserClick = browserAction("browser_click", "Click an element using a fresh opaque ref from browser_observe.", async (page, p, _context, signal, value) => { await assertCurrentPageOrigin(value, signal); const record = consumeElementRef(value, p); assertConsequentialAction(record); if (record.element.href) assertAllowedOrigin(value.allowedOrigin, record.element.href); const result = await page.evaluate(`(()=>{const elements=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')];const e=elements[${record.index}];if(!e) throw new Error('STALE_REF');const signature=JSON.stringify({tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),text:(e.innerText||e.value||e.getAttribute('aria-label')||'').trim().slice(0,300),type:e.getAttribute('type'),name:e.getAttribute('name'),href:e.href||null});if(signature!==${JSON.stringify(record.signature)}) throw new Error('STALE_REF');e.click();return {clicked:true,tag:e.tagName.toLowerCase()}})()`, true, signal); clearBrowserRefs(value); return result; }, { ref: Type.String() });
const browserType = browserAction("browser_type", "Type text into an input using a fresh opaque ref from browser_observe.", async (page, p, _context, signal, value) => { await assertCurrentPageOrigin(value, signal); const record = consumeElementRef(value, p); const result = await page.evaluate(`(()=>{const elements=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')];const e=elements[${record.index}];if(!e) throw new Error('STALE_REF');const signature=JSON.stringify({tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),text:(e.innerText||e.value||e.getAttribute('aria-label')||'').trim().slice(0,300),type:e.getAttribute('type'),name:e.getAttribute('name'),href:e.href||null});if(signature!==${JSON.stringify(record.signature)}) throw new Error('STALE_REF');if(!/^(input|textarea)$/i.test(e.tagName)) throw new Error('Element is not text-editable');e.focus();e.value=${JSON.stringify(p.text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return {typed:true}})()`, true, signal); clearBrowserRefs(value); return result; }, { text: Type.String(), ref: Type.String() });
const browserScroll = browserAction("browser_scroll", "Scroll the page by a number of pixels.", async (page, p, _context, signal) => await page.evaluate(`(()=>{window.scrollBy(${Number(p.x || 0)},${Number(p.y || 600)}); return {scrollX:scrollX,scrollY:scrollY}})()`, true, signal), { x: Type.Optional(Type.Integer()), y: Type.Optional(Type.Integer()) });
export function visibleBrowserTabs(tabs, { allowedOrigin = null, targetId = null, allowCrossOrigin = crossOriginAllowed() } = {}) { return tabs.filter(tab => { if (tab.id === targetId) return true; if (allowCrossOrigin) return true; if (!allowedOrigin || !/^https?:/i.test(tab.url || "")) return false; try { return new URL(tab.url).origin === allowedOrigin; } catch { return false; } }).map(tab => ({ id: tab.id, type: tab.type, title: tab.title, url: tab.url })); }
const browserTabs = defineTool({ name: "browser_tabs", label: "Browser tabs", description: "List origin-authorized browser tabs, or switch to one by target id.", parameters: Type.Object({ sessionId: Type.String(), targetId: Type.Optional(Type.String()) }), execute: async (_id, p, _signal, _update, context) => { const value = session(p, context); const tabs = await json(new URL("/json/list", value.endpoint).href); const visible = visibleBrowserTabs(tabs, { allowedOrigin: value.allowedOrigin, targetId: value.targetId }); if (p.targetId) { const target = tabs.find(tab => tab.id === p.targetId); if (!target?.webSocketDebuggerUrl) throw new Error("Browser tab was not found or is not a page"); if (!visible.some(tab => tab.id === p.targetId)) throw new Error("CROSS_ORIGIN_BLOCKED: browser tab is outside the authorized origin"); assertAllowedOrigin(value.allowedOrigin, target.url); const replacement = await new CdpPage(allowedCdpWebSocket(value.endpoint, target.webSocketDebuggerUrl)).connect(); const previous = value.page; clearBrowserRefs(value); value.page = replacement; value.targetId = target.id; value.allowedOrigin = /^https?:/i.test(target.url || "") ? new URL(target.url).origin : null; bindPage(value); previous.close(); return text({ tabs: visibleBrowserTabs(tabs, { allowedOrigin: value.allowedOrigin, targetId: value.targetId }), switched: p.targetId }); } return text({ tabs: visible, switched: false }); } });
const browserScreenshot = browserAction("browser_screenshot", "Capture a PNG screenshot, optionally creating a new non-overwriting artifact inside the workspace.", async (page, p, context, signal) => { const result = await page.call("Page.captureScreenshot", { format: "png", fromSurface: true }, signal); if (p.path) await writeBrowserArtifact(context?.cwd, p.path, Buffer.from(result.data, "base64")); return { pngBase64: p.path ? undefined : result.data, path: p.path || null }; }, { path: Type.Optional(Type.String()) });
async function cleanupBrowserSession(sessionId, value) {
  try {
    if (value.process) await value.page.call("Browser.close").catch(() => {});
    value.page.close();
    await stopProcess(value.process);
    if (value.profileDir) {
      for (let attempt = 0; attempt < 20; attempt += 1) { await rm(value.profileDir, { recursive: true, force: true }); try { await stat(value.profileDir); await delay(50); } catch (error) { if (error.code === "ENOENT") break; throw error; } }
      try { await stat(value.profileDir); throw new Error("Browser profile cleanup could not be verified"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (value.uploadDir) { await rm(value.uploadDir, { recursive: true, force: true }); try { await stat(value.uploadDir); throw new Error("Browser upload cleanup could not be verified"); } catch (error) { if (error.code !== "ENOENT") throw error; } }
    if (value.downloadDir) { await rm(value.downloadDir, { recursive: true, force: true }); try { await stat(value.downloadDir); throw new Error("Browser download cleanup could not be verified"); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  } finally { sessions.delete(sessionId); }
}
export async function cleanupBrowserSessions(ownerId) { for (const [sessionId, value] of [...sessions]) if (ownerId === undefined || value.ownerId === ownerId) await cleanupBrowserSession(sessionId, value); }
const browserCleanup = defineTool({ name: "browser_cleanup", label: "Browser cleanup", description: "Close one browser session, its launched process, and its isolated temporary profile.", parameters: Type.Object({ sessionId: Type.String() }), execute: async (_id, p, _signal, _update, context) => { await cleanupBrowserSession(p.sessionId, session(p, context)); return text({ cleaned: true, sessionId: p.sessionId }); } });

const computerNames = ["computer_observe", "computer_focus", "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_screenshot"];
const computerTools = computerNames.map(name => defineTool({ name, label: name, description: "Computer control with a capability-detected Windows adapter; explicit unsupported response when unavailable.", parameters: Type.Object({}), execute: async () => unsupported(name) }));
export const browserTools = [browserLaunch, browserConnect, browserObserve, browserUpload, browserDownloadWait, browserNavigate, browserClick, browserType, browserScroll, browserTabs, browserScreenshot, browserCleanup, ...computerTools];
export default function registerBrowserTools(registry) { for (const tool of browserTools) registry.register(tool); return registry; }
