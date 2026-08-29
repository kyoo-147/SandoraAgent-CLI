import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createGitTools } from "../../src/git/tools.mjs";

const execFile = promisify(execFileCallback);
const git = (cwd, ...args) => execFile("git", args, { cwd, encoding: "utf8" });
const text = result => result.content[0].text;

async function execute(tools, name, params, cwd) {
  return tools.find(tool => tool.name === name).execute("test", params, undefined, undefined, { cwd });
}

test("Git tools create, commit, push, inspect, and merge without staging unrelated files", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sandora-git-tools-"));
  const remote = `${root}-remote.git`;
  const tools = createGitTools({ allowLocalMerge: true });
  try {
    await git(root, "init", "-q", "-b", "integration/test");
    await git(root, "config", "user.email", "test@sandora.local");
    await git(root, "config", "user.name", "Sandora Test");
    await writeFile(resolve(root, "README.md"), "base\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "-qm", "base");
    await execFile("git", ["init", "--bare", "-q", remote]);
    await git(root, "remote", "add", "origin", remote);

    await execute(tools, "git_branch_create", { branch: "feat/e2e" }, root);
    await writeFile(resolve(root, "intended.txt"), "intended\n");
    await writeFile(resolve(root, "unrelated.txt"), "unrelated\n");
    await execute(tools, "git_commit", { message: "feat: intended", paths: ["intended.txt"] }, root);
    const status = text(await execute(tools, "git_status", {}, root));
    assert.match(status, /\?\? unrelated\.txt/);
    assert.doesNotMatch(status, /intended\.txt/);
    await execute(tools, "git_push", { branch: "feat/e2e", remote: "origin" }, root);
    assert.equal((await git(root, "rev-parse", "feat/e2e")).stdout.trim(), (await git(root, "rev-parse", "origin/feat/e2e")).stdout.trim());
    assert.match(text(await execute(tools, "git_history", { limit: 2 }, root)), /feat: intended/);

    await git(root, "switch", "integration/test");
    await execute(tools, "git_merge", { branch: "feat/e2e" }, root);
    assert.equal((await readFile(resolve(root, "intended.txt"), "utf8")).replace(/\r\n/g, "\n"), "intended\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test("Git and GitHub contracts reject unsafe names before execution", async () => {
  const tools = createGitTools();
  await assert.rejects(() => execute(tools, "git_branch_create", { branch: "../escape" }, process.cwd()), /Invalid Git branch/);
  await assert.rejects(() => execute(tools, "git_push", { branch: "feat/safe", remote: "bad remote" }, process.cwd()), /Invalid Git remote/);
  assert.deepEqual(tools.filter(tool => tool.name.startsWith("github_pr_")).map(tool => tool.name), ["github_pr_view", "github_pr_create", "github_pr_merge"]);
  await assert.rejects(() => execute(tools, "github_pr_merge", { number: 1 }, process.cwd()), /merge capability is disabled/);
  await assert.rejects(() => execute(tools, "git_push", { branch: "main", remote: "origin" }, process.cwd()), /protected branch/);
});

test("GitHub merge uses deterministic gh preflight and requires successful open PR state", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sandora-fake-gh-"));
  const calls = [];
  try {
    const runGitHub = async args => {
      calls.push(args);
      const output = args[1] === "view" && args.at(-1).includes("mergedAt")
        ? JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", mergeCommit: { oid: "abc" }, url: "https://example.test/pr/7" })
        : args[1] === "view"
          ? JSON.stringify({ state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "APPROVED", statusCheckRollup: [{ name: "qa", status: "COMPLETED", conclusion: "SUCCESS" }] })
          : "merged";
      return { content: [{ type: "text", text: `exit 0\n${output}` }], details: { code: 0 } };
    };
    const tools = createGitTools({ allowPrMerge: true, runGitHub });
    const result = await execute(tools, "github_pr_merge", { number: 7, deleteBranch: false }, root);
    assert.match(text(result), /merged/);
    assert.deepEqual(calls[0].slice(0, 3), ["pr", "view", "7"]);
    assert.deepEqual(calls[1], ["pr", "merge", "7", "--merge"]);
    assert.deepEqual(calls[2].slice(0, 3), ["pr", "view", "7"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub PR creation requires the current clean fully pushed feature branch", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sandora-pr-create-"));
  const remote = `${root}-remote.git`;
  const calls = [];
  try {
    await git(root, "init", "-q", "-b", "feat/pr-ready");
    await git(root, "config", "user.email", "test@sandora.local");
    await git(root, "config", "user.name", "Sandora Test");
    await writeFile(resolve(root, "README.md"), "ready\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "-qm", "ready");
    await execFile("git", ["init", "--bare", "-q", remote]);
    await git(root, "remote", "add", "origin", remote);
    await git(root, "push", "-u", "origin", "feat/pr-ready");
    await writeFile(resolve(root, "unrelated.txt"), "allowed untracked\n");
    const tools = createGitTools({ runGitHub: async args => { calls.push(args); return { content: [{ type: "text", text: "exit 0\nhttps://example.test/pr/1" }], details: { code: 0 } }; } });
    await execute(tools, "github_pr_create", { head: "feat/pr-ready", base: "main", title: "Ready", body: "Verified" }, root);
    assert.equal(calls.length, 1);
    await writeFile(resolve(root, "README.md"), "dirty\n");
    await assert.rejects(() => execute(tools, "github_pr_create", { head: "feat/pr-ready", title: "No", body: "No" }, root), /tracked working-tree changes/);
    assert.equal(calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});
