import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import GitWorktreeManager from "../../src/git/worktrees.mjs";

const execFile = promisify(execFileCallback);
async function git(cwd, ...args) { return execFile("git", args, { cwd, encoding: "utf8" }); }

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "sandora-git-e2e-"));
  await git(root, "init", "-q", "-b", "integration/test");
  await git(root, "config", "user.email", "test@sandora.local");
  await git(root, "config", "user.name", "Sandora Test");
  await writeFile(resolve(root, "README.md"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "base");
  return root;
}

test("GitWorktreeManager creates, validates, collects, integrates, and cleans a worker", async () => {
  const root = await fixture();
  const manager = new GitWorktreeManager({ repoRoot: root, worktreeRoot: resolve(root, ".workers") });
  try {
    const worker = await manager.create("worker-1");
    assert.equal(worker.branch, "sandora/swarm/worker-1");
    await writeFile(resolve(worker.path, "worker.txt"), "worker output\n");
    await git(worker.path, "add", "worker.txt");
    await git(worker.path, "commit", "-qm", "worker change");
    const validation = await manager.validate("worker-1");
    assert.equal(validation.valid, true);
    const collected = await manager.collectDiff("worker-1");
    assert.match(collected.patch, /worker output/);
    assert.equal((await manager.conflicts("worker-1")).conflict, false);
    const order = GitWorktreeManager.integrationOrder([{ workerId: "worker-1" }, { workerId: "worker-2", dependsOn: ["worker-1"] }]);
    assert.deepEqual(order, ["worker-1", "worker-2"]);
    await writeFile(resolve(root, "unrelated-dirty.txt"), "preserve\n");
    await assert.rejects(() => manager.integrate("worker-1", { message: "must refuse dirty target", ownershipToken: worker.ownershipToken }), /dirty target/);
    await rm(resolve(root, "unrelated-dirty.txt"));
    await manager.integrate("worker-1", { message: "integrate worker", ownershipToken: worker.ownershipToken });
    assert.match((await readFile(resolve(root, "worker.txt"), "utf8")), /worker output/);
    const cleanup = await manager.cleanup("worker-1", { ownershipToken: worker.ownershipToken });
    assert.equal(cleanup.cleaned, true);
    assert.equal((await git(root, "branch", "--list", "sandora/swarm/worker-1")).stdout.trim(), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dirty worker cleanup preserves an explicit recovery receipt", async () => {
  const root = await fixture();
  const manager = new GitWorktreeManager({ repoRoot: root, worktreeRoot: resolve(root, ".workers") });
  try {
    const worker = await manager.create("dirty");
    await writeFile(resolve(worker.path, "draft.txt"), "uncommitted\n");
    await assert.rejects(() => manager.cleanup("dirty", { preserveDirty: false, ownershipToken: worker.ownershipToken }), /Refusing to discard/);
    const cleanup = await manager.cleanup("dirty", { ownershipToken: worker.ownershipToken });
    assert.equal(cleanup.cleaned, false);
    assert.equal(cleanup.preserved, true);
    assert.equal((await stat(worker.path)).isDirectory(), true);
    assert.match(await readFile(cleanup.preservationPath, "utf8"), /dW5jb21taXR0ZWQ/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("clean but unintegrated worker remains recoverable", async () => {
  const root = await fixture();
  const manager = new GitWorktreeManager({ repoRoot: root, worktreeRoot: resolve(root, ".workers") });
  try {
    const worker = await manager.create("unmerged");
    await writeFile(resolve(worker.path, "candidate.txt"), "candidate\n");
    await git(worker.path, "add", "candidate.txt");
    await git(worker.path, "commit", "-qm", "candidate change");
    const cleanup = await manager.cleanup("unmerged", { ownershipToken: worker.ownershipToken });
    assert.equal(cleanup.cleaned, false);
    assert.equal(cleanup.preserved, true);
    assert.match(cleanup.reason, /not integrated/);
    assert.equal((await stat(worker.path)).isDirectory(), true);
    assert.match((await git(root, "branch", "--list", worker.branch)).stdout, /sandora\/swarm\/unmerged/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("integration order rejects dependency cycles", () => {
  assert.throws(() => GitWorktreeManager.integrationOrder([{ workerId: "a", dependsOn: ["b"] }, { workerId: "b", dependsOn: ["a"] }]), /cycle/);
});

test("concurrent creation of the same worker publishes one atomic owner", async () => {
  const root = await fixture();
  const manager = new GitWorktreeManager({ repoRoot: root, worktreeRoot: resolve(root, ".workers") });
  try {
    const results = await Promise.allSettled([manager.create("same-worker"), manager.create("same-worker")]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    const metadata = await manager.metadata("same-worker");
    assert.equal(metadata.phase, "ready");
    assert.match(metadata.ownershipToken, /^same-worker:/);
    const registered = (await git(root, "worktree", "list", "--porcelain")).stdout;
    assert.equal((registered.match(/branch refs\/heads\/sandora\/swarm\/same-worker/g) || []).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recover repairs a matching orphan intent for a registered worktree", async () => {
  const root = await fixture();
  const manager = new GitWorktreeManager({ repoRoot: root, worktreeRoot: resolve(root, ".workers") });
  try {
    const worker = await manager.create("recover-added");
    await rm(manager.metadataPath("recover-added"));
    await writeFile(manager.intentPath("recover-added"), JSON.stringify({ ...worker, phase: "worktree-added-metadata-incomplete" }, null, 2));
    const recovery = await manager.recover("recover-added", { ownershipToken: worker.ownershipToken });
    assert.equal(recovery.state, "READY");
    assert.equal(recovery.repaired, true);
    assert.equal((await manager.metadata("recover-added")).ownershipToken, worker.ownershipToken);
    await assert.rejects(() => readFile(manager.intentPath("recover-added"), "utf8"), /ENOENT/);
    assert.equal((await manager.recover("recover-added", { ownershipToken: worker.ownershipToken })).state, "READY");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recover classifies reserved, missing, and conflicting worker ownership without destructive cleanup", async () => {
  const root = await fixture();
  const manager = new GitWorktreeManager({ repoRoot: root, worktreeRoot: resolve(root, ".workers") });
  try {
    await mkdir(manager.metadataRoot, { recursive: true });
    const reserved = { version: 1, phase: "reserved", workerId: "reserved", owner: "test", branch: "sandora/swarm/reserved", baseRef: (await git(root, "rev-parse", "HEAD")).stdout.trim(), path: manager.pathFor("reserved"), repoRoot: manager.repoRoot, ownershipToken: "reserved:token" };
    await writeFile(manager.intentPath("reserved"), JSON.stringify(reserved));
    assert.equal((await manager.recover("reserved", { ownershipToken: reserved.ownershipToken })).state, "RESERVED_NO_WORKTREE");

    const worker = await manager.create("missing");
    await git(root, "worktree", "remove", worker.path);
    assert.equal((await manager.recover("missing", { ownershipToken: worker.ownershipToken })).state, "MISSING_WORKTREE");

    const conflict = await manager.create("conflict");
    await writeFile(manager.intentPath("conflict"), JSON.stringify({ ...conflict, phase: "reserved", ownershipToken: "conflict:foreign" }));
    assert.equal((await manager.recover("conflict", { ownershipToken: conflict.ownershipToken })).state, "OWNER_CONFLICT");
    assert.equal((await stat(conflict.path)).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("metadata identity tampering fails closed", async () => {
  const root = await fixture();
  const manager = new GitWorktreeManager({ repoRoot: root, worktreeRoot: resolve(root, ".workers") });
  try {
    const worker = await manager.create("tampered");
    await writeFile(manager.metadataPath("tampered"), JSON.stringify({ ...worker, path: resolve(root, "outside") }));
    await assert.rejects(() => manager.inspect("tampered"), /path or repository mismatch/);
    await assert.rejects(() => manager.cleanup("tampered", { ownershipToken: worker.ownershipToken }), /path or repository mismatch/);
    await writeFile(manager.metadataPath("tampered"), JSON.stringify({ ...worker, baseRef: "--output=outside.patch" }));
    await assert.rejects(() => manager.collectDiff("tampered"), /base commit is invalid/);
    await assert.rejects(() => stat(resolve(worker.path, "outside.patch")), /ENOENT/);
    assert.equal((await stat(worker.path)).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner-sensitive worker mutations require the matching token", async () => {
  const root = await fixture();
  const manager = new GitWorktreeManager({ repoRoot: root, worktreeRoot: resolve(root, ".workers") });
  try {
    const worker = await manager.create("fenced");
    await assert.rejects(() => manager.cleanup("fenced"), /token is required/);
    await assert.rejects(() => manager.cleanup("fenced", { ownershipToken: "fenced:foreign" }), /token mismatch/);
    assert.equal((await stat(worker.path)).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
