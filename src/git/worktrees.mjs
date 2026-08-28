import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm, access, lstat, realpath } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, resolve, relative, basename } from "node:path";

const execFile = promisify(execFileCallback);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function safeId(id) {
  if (!ID_RE.test(id)) throw new Error("Worker id must contain only letters, numbers, dot, underscore, or hyphen");
  return id;
}
function safeRef(ref, label) {
  if (typeof ref !== "string" || !ref || ref.startsWith("-") || ref.includes("..") || ref.includes("@{")) throw new Error(`Invalid ${label}`);
  return ref;
}

function isProtectedBranch(branch) { return ["main", "master"].includes(branch.toLowerCase()); }

export class GitWorktreeError extends Error {
  constructor(message, result = {}) { super(message); this.name = "GitWorktreeError"; Object.assign(this, result); }
}

export class GitWorktreeManager {
  constructor({ repoRoot = process.cwd(), worktreeRoot, metadataRoot } = {}) {
    this.repoRoot = resolve(repoRoot);
    this.worktreeRoot = resolve(worktreeRoot || resolve(this.repoRoot, ".sandora", "worktrees"));
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
    const distance = relative(this.worktreeRoot, path);
    if (!distance || distance === ".." || distance.startsWith(`..${requireSeparator()}`)) throw new Error("Worktree path escaped manager root");
    safeRef(baseRef, "base ref");
    safeRef(branchName, "worker branch");
    if (!branchName.startsWith("sandora/swarm/") || isProtectedBranch(branchName)) throw new Error("Worker branch must use the sandora/swarm namespace");
    await this.git(["check-ref-format", "--branch", branchName]);
    const dirty = await this.dirtyState(this.repoRoot, { ignore: [relative(this.repoRoot, dirname(this.worktreeRoot))] });
    await mkdir(this.worktreeRoot, { recursive: true });
    await mkdir(this.metadataRoot, { recursive: true });
    try {
      await access(path);
      throw new GitWorktreeError(`Worker worktree already exists: ${path}`);
    } catch (error) { if (error instanceof GitWorktreeError) throw error; }
    const baseCommit = (await this.git(["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();
    const result = await this.git(["worktree", "add", "-b", branchName, path, baseCommit]);
    const metadata = { version: 1, workerId, owner, branch: branchName, baseRef: baseCommit, path, repoRoot: this.repoRoot, createdAt: new Date().toISOString(), ownershipToken: `${workerId}:${Date.now()}`, sourceDirty: dirty };
    await writeFile(this.metadataPath(workerId), JSON.stringify(metadata, null, 2) + "\n", "utf8");
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
    const canonicalRoot = await realpath(cwd);
    for (const file of untrackedList.stdout.split("\0").filter(Boolean)) {
      if (isIgnored(file)) continue;
      try {
        const candidate = resolve(cwd, file);
        const info = await lstat(candidate);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const actual = await realpath(candidate);
        const distance = relative(canonicalRoot, actual);
        if (distance === ".." || distance.startsWith(`..${requireSeparator()}`)) continue;
        untracked[file] = Buffer.from(await readFile(actual)).toString("base64");
      } catch { /* file disappeared or escaped during scan */ }
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
    safeRef(targetRef, "target ref");
    const currentBranch = (await this.git(["branch", "--show-current"])).stdout.trim();
    if (!currentBranch || isProtectedBranch(currentBranch)) throw new GitWorktreeError(`Refusing worker integration into protected or detached target: ${currentBranch || "detached"}`);
    const targetOid = (await this.git(["rev-parse", "--verify", `${targetRef}^{commit}`])).stdout.trim();
    const headOid = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    if (targetOid !== headOid) throw new GitWorktreeError("Integration targetRef does not match current HEAD");
    const conflict = await this.conflicts(workerId, targetOid);
    if (conflict.conflict) throw new GitWorktreeError(`Integration conflict for ${workerId}`, conflict);
    const state = await this.dirtyState(this.repoRoot, { ignore: [relative(this.repoRoot, dirname(this.worktreeRoot))] });
    if (state.dirty) throw new GitWorktreeError("Refusing integration into a dirty target", { state });
    const recheckedHead = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    if (recheckedHead !== headOid) throw new GitWorktreeError("Integration target changed during validation");
    const result = await this.git(["merge", "--no-ff", metaBranch(await this.metadata(workerId)), "-m", message || `Integrate worker ${workerId}`]);
    return { workerId, integrated: true, output: result.stdout.trim() };
  }

  async cleanup(workerId, { preserveDirty = true, deleteBranch = true, targetRef = "HEAD" } = {}) {
    const meta = await this.metadata(workerId);
    const state = await this.dirtyState(meta.path);
    if (state.dirty) {
      if (!preserveDirty) throw new GitWorktreeError(`Refusing to discard dirty worker ${workerId}`, { state });
      const preservationPath = resolve(this.metadataRoot, `${workerId}.dirty.json`);
      await writeFile(preservationPath, JSON.stringify({ workerId, preservedAt: new Date().toISOString(), ...state }, null, 2) + "\n");
      return { workerId, cleaned: false, preserved: true, reason: "dirty worker requires recovery", preservationPath, path: meta.path, branch: meta.branch };
    }
    const merged = await this.git(["merge-base", "--is-ancestor", meta.branch, targetRef], { allowFailure: true });
    if (merged.code !== 0) return { workerId, cleaned: false, preserved: true, reason: `branch is not integrated into ${targetRef}`, preservationPath: null, path: meta.path, branch: meta.branch };
    await this.git(["worktree", "remove", meta.path]);
    if (deleteBranch) await this.git(["branch", "-d", meta.branch]);
    await rm(this.metadataPath(workerId), { force: true });
    return { workerId, cleaned: true, preserved: false, preservationPath: null };
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
