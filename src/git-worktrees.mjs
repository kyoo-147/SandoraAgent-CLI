import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { resolve, relative, basename } from "node:path";

const execFile = promisify(execFileCallback);
const METADATA_FILE = ".sandora-worktree.json";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function safeId(id) {
  if (!ID_RE.test(id)) throw new Error("Worker id must contain only letters, numbers, dot, underscore, or hyphen");
  return id;
}

export class GitWorktreeError extends Error {
  constructor(message, result = {}) { super(message); this.name = "GitWorktreeError"; Object.assign(this, result); }
}

export class GitWorktreeManager {
  constructor({ repoRoot = process.cwd(), worktreeRoot, metadataRoot } = {}) {
    this.repoRoot = resolve(repoRoot);
    this.worktreeRoot = resolve(worktreeRoot || resolve(this.repoRoot, ".sandora-worktrees"));
    this.metadataRoot = resolve(metadataRoot || resolve(this.worktreeRoot, "metadata"));
  }

  async git(args, { cwd = this.repoRoot, allowFailure = false } = {}) {
    try {
      const result = await execFile("git", args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" });
      return { ...result, code: 0 };
    } catch (error) {
      const result = { stdout: error.stdout || "", stderr: error.stderr || error.message, code: error.code ?? 1 };
      if (allowFailure) return result;
      throw new GitWorktreeError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`, result);
    }
  }

  pathFor(workerId) { return resolve(this.worktreeRoot, safeId(workerId)); }
  metadataPath(workerId) { return resolve(this.metadataRoot, `${safeId(workerId)}.json`); }

  async create(workerId, { baseRef = "HEAD", branch, owner = process.env.USERNAME || process.env.USER || "unknown" } = {}) {
    safeId(workerId);
    const path = this.pathFor(workerId);
    const branchName = branch || `sandora/swarm/${workerId}`;
    if (resolve(path).startsWith(`${this.worktreeRoot}${requireSeparator()}`) === false) throw new Error("Worktree path escaped manager root");
    await mkdir(this.worktreeRoot, { recursive: true });
    await mkdir(this.metadataRoot, { recursive: true });
    try {
      await access(path);
      throw new GitWorktreeError(`Worker worktree already exists: ${path}`);
    } catch (error) { if (error instanceof GitWorktreeError) throw error; }
    const dirty = await this.dirtyState(this.repoRoot);
    const baseCommit = (await this.git(["rev-parse", baseRef])).stdout.trim();
    const result = await this.git(["worktree", "add", "-b", branchName, path, baseRef]);
    const metadata = { version: 1, workerId, owner, branch: branchName, baseRef: baseCommit, path, repoRoot: this.repoRoot, createdAt: new Date().toISOString(), ownershipToken: `${workerId}:${Date.now()}`, sourceDirty: dirty };
    await writeFile(this.metadataPath(workerId), JSON.stringify(metadata, null, 2) + "\n", "utf8");
    await writeFile(resolve(path, METADATA_FILE), JSON.stringify(metadata, null, 2) + "\n", "utf8");
    return { ...metadata, output: result.stdout.trim() };
  }

  async metadata(workerId) { return JSON.parse(await readFile(this.metadataPath(workerId), "utf8")); }
  async dirtyState(cwd, { ignore = [] } = {}) {
    const status = await this.git(["status", "--porcelain=v1", "-z"], { cwd });
    const diff = await this.git(["diff", "--binary"], { cwd });
    const staged = await this.git(["diff", "--cached", "--binary"], { cwd });
    const untrackedList = await this.git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
    const ignored = ignore.map((item) => resolve(cwd, item));
    const isIgnored = (file) => ignored.some((prefix) => { const candidate = resolve(cwd, file); return candidate === prefix || candidate.startsWith(prefix + "/") || candidate.startsWith(prefix + "\\"); });
    const untracked = {};
    for (const file of untrackedList.stdout.split("\0").filter(Boolean)) {
      if (isIgnored(file)) continue;
      try { untracked[file] = Buffer.from(await readFile(resolve(cwd, file))).toString("base64"); } catch { /* file disappeared during scan */ }
    }
    const statusFiles = status.stdout.split("\0").filter(Boolean).filter((entry) => !isIgnored(entry.slice(3)));
    return { status: statusFiles.join("\0"), patch: diff.stdout, stagedPatch: staged.stdout, untracked, dirty: Boolean(statusFiles.length) };
  }

  async inspect(workerId) {
    const meta = await this.metadata(workerId);
    const state = await this.dirtyState(meta.path);
    const branch = await this.git(["branch", "--show-current"], { cwd: meta.path });
    return { ...meta, ...state, branch: branch.stdout.trim() };
  }

  async collectDiff(workerId) {
    const meta = await this.metadata(workerId);
    const result = await this.git(["diff", "--binary", meta.baseRef, meta.branch], { cwd: meta.path });
    const working = await this.git(["diff", "--binary", meta.baseRef], { cwd: meta.path });
    return { workerId, branch: meta.branch, baseRef: meta.baseRef, patch: result.stdout, workingPatch: working.stdout, changed: Boolean(result.stdout || working.stdout) };
  }

  async validate(workerId, { command = ["status", "--porcelain"] } = {}) {
    const meta = await this.metadata(workerId);
    const check = await this.git(["diff", "--check", meta.baseRef], { cwd: meta.path, allowFailure: true });
    const commandResult = await this.git(command, { cwd: meta.path, allowFailure: true });
    return { workerId, valid: check.code === 0 && commandResult.code === 0, diffCheck: check, command: commandResult };
  }

  async conflicts(workerId, targetRef = "HEAD") {
    const meta = await this.metadata(workerId);
    const result = await this.git(["merge-tree", "--write-tree", targetRef, meta.branch], { cwd: this.repoRoot, allowFailure: true });
    return { workerId, targetRef, branch: meta.branch, conflict: result.code !== 0, output: `${result.stdout}${result.stderr}`.trim() };
  }

  async integrate(workerId, { targetRef = "HEAD", message } = {}) {
    const conflict = await this.conflicts(workerId, targetRef);
    if (conflict.conflict) throw new GitWorktreeError(`Integration conflict for ${workerId}`, conflict);
    const state = await this.dirtyState(this.repoRoot, { ignore: [relative(this.repoRoot, this.worktreeRoot)] });
    if (state.dirty) throw new GitWorktreeError("Refusing integration into a dirty target", { state });
    const result = await this.git(["merge", "--no-ff", metaBranch(await this.metadata(workerId)), "-m", message || `Integrate worker ${workerId}`]);
    return { workerId, integrated: true, output: result.stdout.trim() };
  }

  async cleanup(workerId, { preserveDirty = true, deleteBranch = true } = {}) {
    const meta = await this.metadata(workerId);
    const state = await this.dirtyState(meta.path);
    let preservationPath;
    if (state.dirty) {
      if (!preserveDirty) throw new GitWorktreeError(`Refusing to discard dirty worker ${workerId}`, { state });
      preservationPath = resolve(this.metadataRoot, `${workerId}.dirty.json`);
      await writeFile(preservationPath, JSON.stringify({ workerId, preservedAt: new Date().toISOString(), ...state }, null, 2) + "\n");
    }
    await this.git(["worktree", "remove", "--force", meta.path]);
    if (deleteBranch) await this.git(["branch", "-D", meta.branch], { allowFailure: true });
    await rm(this.metadataPath(workerId), { force: true });
    return { workerId, cleaned: true, preservationPath: preservationPath || null };
  }

  async recover(workerId) {
    const meta = await this.metadata(workerId);
    const result = await this.git(["worktree", "prune", "--dry-run"], { allowFailure: true });
    return { workerId, registered: result.code === 0, path: meta.path, output: result.stdout.trim() };
  }

  static integrationOrder(workers) {
    const map = new Map(workers.map((worker) => [worker.workerId, worker]));
    const output = [], visiting = new Set(), visited = new Set();
    const visit = (id) => { if (visiting.has(id)) throw new Error(`Integration dependency cycle at ${id}`); if (visited.has(id)) return; const worker = map.get(id); if (!worker) throw new Error(`Unknown integration dependency: ${id}`); visiting.add(id); for (const dep of worker.dependsOn || []) visit(dep); visiting.delete(id); visited.add(id); output.push(id); };
    for (const worker of workers) visit(worker.workerId);
    return output;
  }
}

function requireSeparator() { return process.platform === "win32" ? "\\" : "/"; }
function metaBranch(meta) { return meta.branch; }

export default GitWorktreeManager;
