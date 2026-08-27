import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import GitWorktreeManager from "../src/git-worktrees.mjs";

const execFile = promisify(execFileCallback);
async function git(cwd, ...args) { return execFile("git", args, { cwd, encoding: "utf8" }); }

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "sandora-git-e2e-"));
  await git(root, "init", "-q");
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
    await manager.integrate("worker-1", { message: "integrate worker" });
    assert.match((await readFile(resolve(root, "worker.txt"), "utf8")), /worker output/);
    const cleanup = await manager.cleanup("worker-1");
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
    await assert.rejects(() => manager.cleanup("dirty", { preserveDirty: false }), /Refusing to discard/);
    const cleanup = await manager.cleanup("dirty");
    assert.equal(cleanup.cleaned, true);
    assert.match(await readFile(cleanup.preservationPath, "utf8"), /dW5jb21taXR0ZWQ/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("integration order rejects dependency cycles", () => {
  assert.throws(() => GitWorktreeManager.integrationOrder([{ workerId: "a", dependsOn: ["b"] }, { workerId: "b", dependsOn: ["a"] }]), /cycle/);
});
