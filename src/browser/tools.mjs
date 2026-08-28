import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { defineTool } from "../tools/registry.mjs";
import { filteredEnvironment } from "../tools/coding-tools.mjs";

const sessions = new Map();
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
  let parent = dirname(candidate);
  while (true) {
    try { parent = await realpath(parent); break; }
    catch (error) {
      if (error.code !== "ENOENT" || parent === root) throw error;
      parent = dirname(parent);
    }
  }
  assertInside(root, parent);
  await mkdir(dirname(candidate), { recursive: true });
  return candidate;
}

function text(value, details = {}) { return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details }; }
function unsupported(operation) { return text({ supported: false, operation, reason: "Computer control is unavailable on this platform or no Windows adapter is installed." }, { supported: false }); }
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const closed = new Promise(resolveClose => child.once("close", resolveClose));
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
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
    const req = request(url, { method }, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
      response.on("end", () => { try { const value = JSON.parse(body); response.statusCode >= 400 ? reject(new Error(`CDP HTTP ${response.statusCode}`)) : resolvePromise(value); } catch (error) { reject(error); } });
    });
    const abort = () => req.destroy(signal.reason || new Error("Browser request cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    req.on("error", reject); req.on("close", () => signal?.removeEventListener("abort", abort)); req.end();
  });
}

class CdpPage {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.pending = new Map(); this.id = 0; }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolvePromise, reject) => { this.ws.addEventListener("open", resolvePromise, { once: true }); this.ws.addEventListener("error", reject, { once: true }); });
    this.ws.addEventListener("message", event => { const message = JSON.parse(event.data); if (message.id && this.pending.has(message.id)) { const pending = this.pending.get(message.id); this.pending.delete(message.id); pending.cleanup?.(); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); } });
    this.ws.addEventListener("close", () => { for (const pending of this.pending.values()) { pending.cleanup?.(); pending.reject(new Error("CDP connection closed")); } this.pending.clear(); });
    await this.call("Page.enable"); await this.call("Runtime.enable"); await this.call("DOM.enable");
    return this;
  }
  call(method, params = {}, signal) { return new Promise((resolvePromise, reject) => { if (signal?.aborted) return reject(signal.reason || new Error("Browser action cancelled")); const id = ++this.id; const abort = () => { this.pending.delete(id); reject(signal.reason || new Error("Browser action cancelled")); }; const cleanup = () => signal?.removeEventListener("abort", abort); signal?.addEventListener("abort", abort, { once: true }); this.pending.set(id, { resolve: resolvePromise, reject, cleanup }); try { this.ws.send(JSON.stringify({ id, method, params })); } catch (error) { this.pending.delete(id); cleanup(); reject(error); } }); }
  async evaluate(expression, returnByValue = true, signal) { const result = await this.call("Runtime.evaluate", { expression, returnByValue, awaitPromise: true }, signal); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed"); return result.result?.value; }
  close() { if (this.ws) this.ws.close(); for (const pending of this.pending.values()) { pending.cleanup?.(); pending.reject(new Error("CDP connection closed")); } this.pending.clear(); this.ws = null; }
}

async function connect(endpoint) {
  const base = allowedCdpEndpoint(endpoint || process.env.SANDORA_CDP_URL || "http://127.0.0.1:9222");
  const targets = await json(new URL("/json/list", base).href);
  const target = targets.find(candidate => candidate.type === "page" && candidate.webSocketDebuggerUrl);
  if (!target) throw new Error("CDP endpoint did not provide a page target");
  const page = await new CdpPage(target.webSocketDebuggerUrl).connect();
  const id = String(nextId++); sessions.set(id, { page, process: null, endpoint: base }); return { id, page };
}

async function launch(endpoint) {
  if (endpoint || process.env.SANDORA_CDP_URL) return connect(endpoint);
  const executable = await browserExecutable();
  const port = 9222 + Math.floor(Math.random() * 500);
  const profileDir = await mkdtemp(join(tmpdir(), "sandora-browser-"));
  const child = spawn(executable, [`--headless=new`, `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { env: filteredEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const base = `http://127.0.0.1:${port}`;
  let lastError = "";
  for (let attempt = 0; attempt < 40; attempt++) { try { const result = await connect(base); Object.assign(sessions.get(result.id), { process: child, profileDir }); return result; } catch (error) { lastError = error.message; await delay(100); } }
  await stopProcess(child); await rm(profileDir, { recursive: true, force: true }); throw new Error(`Unable to launch/connect browser: ${lastError}`);
}

const browserLaunch = defineTool({ name: "browser_launch", label: "Browser launch", description: "Launch a headless Chromium browser or connect to SANDORA_CDP_URL.", parameters: Type.Object({ endpoint: Type.Optional(Type.String()) }), execute: async (_id, params) => { const result = await launch(params.endpoint); return text({ sessionId: result.id, connected: true }); } });
const browserConnect = defineTool({ name: "browser_connect", label: "Browser connect", description: "Connect to an existing Chrome DevTools Protocol endpoint.", parameters: Type.Object({ endpoint: Type.String() }), execute: async (_id, params) => { const result = await connect(params.endpoint); return text({ sessionId: result.id, connected: true }); } });
function session(params) { const value = sessions.get(params.sessionId); if (!value) throw new Error("Unknown browser session"); return value; }
function clearBrowserRefs(value) { value.observationGeneration = (value.observationGeneration || 0) + 1; value.refs = new Map(); }
function elementSignature(element) { return JSON.stringify({ tag: element.tag, role: element.role, text: element.text, type: element.type, name: element.name, href: element.href || null }); }
function resolveElementRef(value, params) {
  if (!params.ref) throw new Error("A fresh browser_observe element ref is required");
  const record = value.refs?.get(params.ref);
  if (!record || record.generation !== value.observationGeneration) throw new Error("STALE_REF: observe the page again before acting");
  return record;
}
function assertConsequentialAction(record) {
  const destructive = /^(submit|image)$/i.test(record.element.type || "") || /(submit|send|buy|pay|delete|remove|confirm|ship)/i.test(record.element.text || "");
  if (destructive && process.env.SANDORA_ALLOW_BROWSER_SUBMIT !== "1") throw new Error("Browser consequential action blocked; set SANDORA_ALLOW_BROWSER_SUBMIT=1 with explicit authority");
}
const browserObserve = defineTool({ name: "browser_observe", label: "Browser observe", description: "Return structured URL, title, text, and short-lived opaque refs for interactive elements.", parameters: Type.Object({ sessionId: Type.String() }), execute: async (_id, params, signal) => { const value = session(params); const observed = await value.page.evaluate(`({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,12000),elements:[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].slice(0,200).map((e,i)=>({index:i,tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),text:(e.innerText||e.value||e.getAttribute('aria-label')||'').trim().slice(0,300),type:e.getAttribute('type'),name:e.getAttribute('name'),href:e.href||null,disabled:!!e.disabled}))})`, true, signal); clearBrowserRefs(value); observed.elements = observed.elements.map(element => { const ref = `b${params.sessionId}-g${value.observationGeneration}-e${element.index}`; value.refs.set(ref, { generation: value.observationGeneration, index: element.index, signature: elementSignature(element), element }); return { ...element, ref, index: undefined }; }); return text(observed, { observationGeneration: value.observationGeneration }); } });
const browserNavigate = defineTool({ name: "browser_navigate", label: "Browser navigate", description: "Navigate the current browser page to an HTTP(S) URL without embedded credentials, invalidating prior element refs.", parameters: Type.Object({ sessionId: Type.String(), url: Type.String() }), execute: async (_id, params, signal) => { const value = session(params); const url = allowedNavigation(params.url); clearBrowserRefs(value); await value.page.call("Page.navigate", { url }, signal); return text({ url }); } });
const browserAction = (name, description, action, properties) => defineTool({ name, label: name, description, parameters: Type.Object({ sessionId: Type.String(), ...properties }), execute: async (_id, params, signal, _update, context) => { if (signal?.aborted) throw new Error("Browser action cancelled"); const value = session(params); return text(await action(value.page, params, context, signal, value)); } });
const browserClick = browserAction("browser_click", "Click an element using a fresh opaque ref from browser_observe.", async (page, p, _context, signal, value) => { const record = resolveElementRef(value, p); assertConsequentialAction(record); const result = await page.evaluate(`(()=>{const elements=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')];const e=elements[${record.index}];if(!e) throw new Error('STALE_REF');const signature=JSON.stringify({tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),text:(e.innerText||e.value||e.getAttribute('aria-label')||'').trim().slice(0,300),type:e.getAttribute('type'),name:e.getAttribute('name'),href:e.href||null});if(signature!==${JSON.stringify(record.signature)}) throw new Error('STALE_REF');e.click();return {clicked:true,tag:e.tagName.toLowerCase()}})()`, true, signal); clearBrowserRefs(value); return result; }, { ref: Type.String() });
const browserType = browserAction("browser_type", "Type text into an input using a fresh opaque ref from browser_observe.", async (page, p, _context, signal, value) => { const record = resolveElementRef(value, p); const result = await page.evaluate(`(()=>{const elements=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')];const e=elements[${record.index}];if(!e) throw new Error('STALE_REF');const signature=JSON.stringify({tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),text:(e.innerText||e.value||e.getAttribute('aria-label')||'').trim().slice(0,300),type:e.getAttribute('type'),name:e.getAttribute('name'),href:e.href||null});if(signature!==${JSON.stringify(record.signature)}) throw new Error('STALE_REF');if(!/^(input|textarea)$/i.test(e.tagName)) throw new Error('Element is not text-editable');e.focus();e.value=${JSON.stringify(p.text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return {typed:true}})()`, true, signal); clearBrowserRefs(value); return result; }, { text: Type.String(), ref: Type.String() });
const browserScroll = browserAction("browser_scroll", "Scroll the page by a number of pixels.", async (page, p, _context, signal) => await page.evaluate(`(()=>{window.scrollBy(${Number(p.x || 0)},${Number(p.y || 600)}); return {scrollX:scrollX,scrollY:scrollY}})()`, true, signal), { x: Type.Optional(Type.Integer()), y: Type.Optional(Type.Integer()) });
const browserTabs = defineTool({ name: "browser_tabs", label: "Browser tabs", description: "List open browser tabs, or switch to one by target id.", parameters: Type.Object({ sessionId: Type.String(), targetId: Type.Optional(Type.String()) }), execute: async (_id, p) => { const value = session(p); const tabs = await json(new URL("/json/list", value.endpoint).href); if (p.targetId) { const target = tabs.find(tab => tab.id === p.targetId); if (!target?.webSocketDebuggerUrl) throw new Error("Browser tab was not found or is not a page"); value.page.close(); value.page = await new CdpPage(target.webSocketDebuggerUrl).connect(); return text({ tabs: tabs.map(tab => ({ id: tab.id, type: tab.type, title: tab.title, url: tab.url })), switched: p.targetId }); } return text({ tabs: tabs.map(tab => ({ id: tab.id, type: tab.type, title: tab.title, url: tab.url })), switched: false }); } });
const browserScreenshot = browserAction("browser_screenshot", "Capture a PNG screenshot, optionally creating a new non-overwriting artifact inside the workspace.", async (page, p, context, signal) => { const artifactPath = p.path ? await resolveBrowserArtifactPath(context?.cwd, p.path) : null; const result = await page.call("Page.captureScreenshot", { format: "png", fromSurface: true }, signal); if (artifactPath) await writeFile(artifactPath, Buffer.from(result.data, "base64"), { flag: "wx" }); return { pngBase64: artifactPath ? undefined : result.data, path: p.path || null }; }, { path: Type.Optional(Type.String()) });
const browserCleanup = defineTool({ name: "browser_cleanup", label: "Browser cleanup", description: "Close one browser session, its launched process, and its isolated temporary profile.", parameters: Type.Object({ sessionId: Type.String() }), execute: async (_id, p) => { const value = session(p); try { value.page.close(); await stopProcess(value.process); if (value.profileDir) await rm(value.profileDir, { recursive: true, force: true }); } finally { sessions.delete(p.sessionId); } return text({ cleaned: true, sessionId: p.sessionId }); } });

const computerNames = ["computer_observe", "computer_focus", "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_screenshot"];
const computerTools = computerNames.map(name => defineTool({ name, label: name, description: "Computer control with a capability-detected Windows adapter; explicit unsupported response when unavailable.", parameters: Type.Object({}), execute: async () => unsupported(name) }));
export const browserTools = [browserLaunch, browserConnect, browserObserve, browserNavigate, browserClick, browserType, browserScroll, browserTabs, browserScreenshot, browserCleanup, ...computerTools];
export default function registerBrowserTools(registry) { for (const tool of browserTools) registry.register(tool); return registry; }
