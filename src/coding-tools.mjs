import process from "node:process";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { Type } from "typebox";

export const LIMITS = Object.freeze({ maxFileBytes: 2_000_000, maxOutputBytes: 20_000, maxMatches: 200, maxFiles: 500, timeoutMs: 30_000 });
const SKIP = new Set([".git", "node_modules", ".pi"]);

function output(text, details = {}) {
  const value = String(text ?? "");
  return { content: [{ type: "text", text: value.length > LIMITS.maxOutputBytes ? `${value.slice(0, LIMITS.maxOutputBytes)}\n[output truncated]` : value }], details };
}
function isInside(root, candidate) {
  const distance = relative(root, candidate);
  if (distance === ".." || distance.startsWith(`..${sep}`) || distance.startsWith(sep) || distance.includes(`${sep}..${sep}`)) throw new Error("Path must remain inside the workspace (or symlink escapes workspace)");
}
export async function workspaceRoot(cwd) {
  const root = await realpath(cwd);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error("Workspace is not a directory");
  return root;
}
async function safePath(cwd, value, { create = false } = {}) {
  const root = await workspaceRoot(cwd);
  const candidate = resolve(root, value || ".");
  isInside(root, candidate);
  let cursor = candidate;
  if (create) {
    while (true) {
      try { await realpath(cursor); break; } catch (error) {
        if (error.code !== "ENOENT" || cursor === root) throw error;
        cursor = dirname(cursor);
      }
    }
  }
  const actual = await realpath(cursor);
  isInside(root, actual);
  if (create && actual !== candidate && !candidate.startsWith(`${actual}${sep}`)) throw new Error("Path has a symlinked parent outside the workspace");
  if (!create && actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error("Symlink escapes workspace");
  return create ? candidate : actual;
}
async function regularFile(cwd, value, options) {
  const file = await safePath(cwd, value, options);
  const info = await stat(file);
  if (!info.isFile() || info.size > LIMITS.maxFileBytes) throw new Error("File is missing, not regular, or larger than 2 MB");
  return file;
}
async function files(root, base, result = []) {
  if (result.length >= LIMITS.maxFiles) return result;
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const next = resolve(base, entry.name);
    if (entry.isDirectory()) await files(root, next, result);
    else if (entry.isFile()) result.push(next);
    if (result.length >= LIMITS.maxFiles) break;
  }
  return result;
}
function textResult(text, details) { return output(text, details); }

export async function runBounded(command, args, { cwd, signal, timeoutMs = LIMITS.timeoutMs } = {}) {
  const root = await workspaceRoot(cwd);
  if (signal?.aborted) return textResult("aborted before start", { aborted: true, timedOut: false });
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: root, env: filteredEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let text = "", reason = "", settled = false;
    const append = (chunk) => { text = `${text}${chunk}`; if (text.length > LIMITS.maxOutputBytes) text = `${text.slice(0, LIMITS.maxOutputBytes)}\n[output truncated]`; };
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolvePromise(value); } };
    const stop = () => { if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }); else child.kill("SIGTERM"); };
    const abort = () => { reason = "aborted"; stop(); };
    const timer = setTimeout(() => { reason = `timed out after ${timeoutMs}ms`; stop(); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.on("error", (error) => finish(textResult(`${reason || "failed to start"}: ${error.message}`)));
    child.on("close", (code) => finish(textResult(`${reason ? `${reason}; ` : ""}exit ${code ?? "unknown"}\n${text.trim()}`, { code, aborted: reason === "aborted", timedOut: reason.startsWith("timed out") })));
  });
}
export function filteredEnvironment(env = process.env) {
  const allowed = new Set(["path", "pathext", "systemroot", "windir", "home", "userprofile", "appdata", "localappdata", "temp", "tmp", "lang", "lc_all", "pi_offline"]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toLowerCase())));
}

const schemas = {
  path: Type.String(),
  pathOptional: Type.Optional(Type.String()),
  text: Type.String(),
};
export function createCodingTools() {
  return [
    { name: "workspace_list", label: "Workspace list", description: "List regular files inside the workspace.", parameters: Type.Object({ path: schemas.pathOptional }), execute: async (_id, p, _s, _u, ctx) => { const root = await workspaceRoot(ctx.cwd); const base = await safePath(root, p.path || "."); const info = await stat(base); const found = info.isDirectory() ? await files(root, base) : [base]; return textResult(found.map((f) => relative(root, f)).join("\n") || "No files.", { count: found.length }); } },
    { name: "workspace_read", label: "Workspace read", description: "Read a bounded UTF-8 file inside the workspace.", parameters: Type.Object({ path: schemas.path, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }), execute: async (_id, p, _s, _u, ctx) => { const file = await regularFile(ctx.cwd, p.path); const rows = (await readFile(file, "utf8")).split(/\r?\n/); const start = p.offset || 1, end = Math.min(rows.length, start + (p.limit || 200) - 1); return textResult(rows.slice(start - 1, end).map((r, i) => `${start + i}: ${r}`).join("\n"), { start, end }); } },
    { name: "workspace_search", label: "Workspace search", description: "Search bounded UTF-8 workspace files.", parameters: Type.Object({ pattern: schemas.text, path: schemas.pathOptional }), execute: async (_id, p, signal, _u, ctx) => { const root = await workspaceRoot(ctx.cwd), base = await safePath(root, p.path || "."), info = await stat(base); const found = info.isFile() ? [base] : await files(root, base); const matches = []; for (const file of found) { if (signal?.aborted) throw new Error("Workspace search aborted"); try { const rows = (await readFile(file, "utf8")).split(/\r?\n/); rows.forEach((line, i) => { if (matches.length < LIMITS.maxMatches && line.toLocaleLowerCase().includes(p.pattern.toLocaleLowerCase())) matches.push(`${relative(root, file)}:${i + 1}: ${line}`); }); } catch {} } return textResult(matches.join("\n") || "No matches.", { matchCount: matches.length }); } },
    { name: "workspace_write", label: "Workspace write", description: "Create or replace a bounded text file.", parameters: Type.Object({ path: schemas.path, content: schemas.text }), execute: async (_id, p, _s, _u, ctx) => { const file = await safePath(ctx.cwd, p.path, { create: true }); if (Buffer.byteLength(p.content) > LIMITS.maxFileBytes) throw new Error("Content exceeds 2 MB"); await mkdir(dirname(file), { recursive: true }); await writeFile(file, p.content, "utf8", { flag: "w" }); return textResult(`Wrote ${relative(await workspaceRoot(ctx.cwd), file)}`, { bytes: Buffer.byteLength(p.content) }); } },
    { name: "workspace_edit", label: "Workspace edit", description: "Replace one exact text occurrence in a bounded file.", parameters: Type.Object({ path: schemas.path, oldText: schemas.text, newText: schemas.text }), execute: async (_id, p, _s, _u, ctx) => { const file = await regularFile(ctx.cwd, p.path); const before = await readFile(file, "utf8"); const count = before.split(p.oldText).length - 1; if (!p.oldText || count !== 1) throw new Error(count ? "Edit must match exactly once" : "Edit text not found"); const after = before.replace(p.oldText, p.newText); if (Buffer.byteLength(after) > LIMITS.maxFileBytes) throw new Error("Edited file exceeds 2 MB"); await writeFile(file, after, "utf8"); return textResult(`Edited ${p.path}`, { bytes: Buffer.byteLength(after) }); } },
    { name: "workspace_shell", label: "Workspace shell", description: "Run a bounded shell command in the workspace with filtered environment.", parameters: Type.Object({ command: schemas.text, timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.timeoutMs })) }), execute: async (_id, p, signal, _u, ctx) => process.platform === "win32" ? runBounded(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", p.command], { cwd: ctx.cwd, signal, timeoutMs: p.timeoutMs }) : runBounded("/bin/sh", ["-lc", p.command], { cwd: ctx.cwd, signal, timeoutMs: p.timeoutMs }) },
    { name: "git_observe", label: "Git observe", description: "Observe Git state without mutation.", parameters: Type.Object({ view: Type.Optional(Type.Union([Type.Literal("status"), Type.Literal("diff"), Type.Literal("log"), Type.Literal("branches")])) }), execute: async (_id, p, signal, _u, ctx) => { const args = { status: ["status", "--short", "--branch"], diff: ["diff", "--stat"], log: ["log", "-5", "--oneline"], branches: ["branch", "--list"] }[p.view || "status"]; return runBounded("git", args, { cwd: ctx.cwd, signal }); } },
  ];
}
export function registerCodingTools(pi) { for (const tool of createCodingTools()) pi.registerTool(tool); }
export default registerCodingTools;
