import process from "node:process";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep, win32, posix } from "node:path";
import { defineTool } from "./registry.mjs";
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
export async function workspaceRelativePath(cwd, value) {
  const root = await workspaceRoot(cwd);
  const candidate = resolve(root, value || ".");
  isInside(root, candidate);
  const path = relative(root, candidate);
  if (!path) throw new Error("A workspace-relative path is required");
  return path;
}
export async function safePath(cwd, value, { create = false } = {}) {
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
export function assertSafeShellCommand(command) {
  if (typeof command !== "string" || !command.trim()) throw new Error("Shell command is required");
  const normalized = command.replace(/\^\r?\n/g, " ").trim();
  const denied = [
    /(^|[;&|]\s*)(shutdown|reboot|halt|poweroff|format|diskpart|bcdedit|reg\s+delete)\b/i,
    /\brm\s+-[^\r\n]*r[^\r\n]*f[^\r\n]*(\/|~)\s*($|[;&|])/i,
    /\b(del|erase)\s+\/s\s+\/q\s+[a-z]:\\/i,
    /\b(remove-item|rd|rmdir)\b[^\r\n]*(\/|\\)(windows|users|program files)\b/i,
    /(^|[\s"'])\.\.(\/|\\)/,
    /(^|[\s"'])[a-z]:\\/i,
    /(^|[\s"'])\\\\/,
    /\b(env|set)\s*($|[;&|])/i,
    /get-childitem\s+env:/i,
  ];
  if (denied.some(pattern => pattern.test(normalized))) throw new Error("Command rejected by workspace safety policy");
  return normalized;
}

const DEVELOPMENT_COMMANDS = new Set(["node", "node.exe", "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun", "bun.exe", "cargo", "cargo.exe", "rustc", "rustc.exe", "go", "go.exe", "uv", "uv.exe", "pytest", "pytest.exe", "python", "python.exe", "python3"]);
export function parseSafeDevelopmentCommand(command) {
  const normalized = assertSafeShellCommand(command);
  if (/[;&|<>`$%\r\n]/.test(normalized)) throw new Error("Shell composition, expansion, and redirection are not available; run one development command at a time");
  const words = [];
  let word = "", quote = null;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (quote) {
      if (character === quote) quote = null;
      else word += character;
    } else if (character === "\"" || character === "'") quote = character;
    else if (/\s/.test(character)) { if (word) { words.push(word); word = ""; } }
    else word += character;
  }
  if (quote) throw new Error("Unterminated command quote");
  if (word) words.push(word);
  const [executable, ...args] = words;
  if (!DEVELOPMENT_COMMANDS.has((executable || "").toLowerCase())) throw new Error("Command is not in the workspace development allowlist");
  const dangerousInterpreterFlag = /^(?:-[cepr]|--(?:eval|print|require|import|input-type))(?:=|$)/i;
  for (const arg of args) {
    if (dangerousInterpreterFlag.test(arg)) throw new Error("Inline interpreter execution is not available");
    if (win32.isAbsolute(arg) || posix.isAbsolute(arg) || /(^|[\\/])\.\.([\\/]|$)/.test(arg)) throw new Error("Command arguments must remain workspace-relative");
  }
  return { executable, args };
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
    { name: "workspace_delete", label: "Workspace delete", description: "Delete one regular file inside the workspace. Directories are never removed.", parameters: Type.Object({ path: schemas.path }), execute: async (_id, p, _s, _u, ctx) => { const file = await regularFile(ctx.cwd, p.path); await unlink(file); return textResult(`Deleted ${relative(await workspaceRoot(ctx.cwd), file)}`); } },
    { name: "workspace_shell", label: "Workspace shell", description: "Run one bounded allowlisted development command without shell composition, expansion, or redirection.", parameters: Type.Object({ command: schemas.text, timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.timeoutMs })) }), execute: async (_id, p, signal, _u, ctx) => { const { executable, args } = parseSafeDevelopmentCommand(p.command); return runBounded(executable, args, { cwd: ctx.cwd, signal, timeoutMs: p.timeoutMs }); } },
  ];
}
export function registerCodingTools(registry) { for (const tool of createCodingTools()) registry.register(tool); return registry; }
export default registerCodingTools;
