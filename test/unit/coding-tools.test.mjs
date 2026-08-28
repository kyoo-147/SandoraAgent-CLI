import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeShellCommand, atomicReplaceFile, createCodingTools, filteredEnvironment, parseSafeDevelopmentCommand, runBounded, workspaceRoot } from "../../src/tools/coding-tools.mjs";

const context = (cwd) => ({ cwd });
const tool = (name) => createCodingTools().find((item) => item.name === name);

test("registry exposes bounded coding and observation tools", () => {
  assert.deepEqual(createCodingTools().map((item) => item.name), [
    "workspace_list", "workspace_read", "workspace_search", "workspace_write", "workspace_edit", "workspace_delete", "workspace_shell",
  ]);
});

test("path policy rejects traversal and symlink escape, including new writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-tools-"));
  const outside = await mkdtemp(join(tmpdir(), "sandora-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(root, "link"), "junction");
  await assert.rejects(() => tool("workspace_read").execute("1", { path: "../secret.txt" }, null, null, context(root)), /inside/);
  await assert.rejects(() => tool("workspace_read").execute("1", { path: "link/secret.txt" }, null, null, context(root)), /escape/);
  await assert.rejects(() => tool("workspace_write").execute("1", { path: "link/new.txt", content: "x" }, null, null, context(root)), /symlink|outside|workspace/);
});

test("write and edit require exact bounded operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-tools-"));
  await tool("workspace_write").execute("1", { path: "nested/a.txt", content: "one\ntwo\n" }, null, null, context(root));
  await tool("workspace_edit").execute("2", { path: "nested/a.txt", oldText: "two", newText: "TWO" }, null, null, context(root));
  assert.equal((await tool("workspace_read").execute("3", { path: "nested/a.txt" }, null, null, context(root))).content[0].text, "1: one\n2: TWO\n3: ");
  await assert.rejects(() => tool("workspace_edit").execute("4", { path: "nested/a.txt", oldText: "", newText: "x" }, null, null, context(root)), /found|once/);
  await tool("workspace_delete").execute("5", { path: "nested/a.txt" }, null, null, context(root));
  await assert.rejects(() => readFile(join(root, "nested/a.txt")), /ENOENT/);
});

test("shell filters credentials and caps output", async () => {
  const env = filteredEnvironment({ PATH: "ok", OPENAI_API_KEY: "do-not-pass" });
  assert.equal(env.OPENAI_API_KEY, undefined);
  const root = await mkdtemp(join(tmpdir(), "sandora-tools-"));
  const result = await tool("workspace_shell").execute("1", { command: "node --version" }, null, null, context(root));
  assert.match(result.content[0].text, /exit 0/);
  assert.ok(!result.content[0].text.includes("do-not-pass"));
  assert.throws(() => assertSafeShellCommand("shutdown /s"), /safety policy/);
  assert.throws(() => assertSafeShellCommand("cd ../outside"), /safety policy/);
  assert.throws(() => assertSafeShellCommand("C:\\Windows\\System32\\cmd.exe"), /safety policy/);
  assert.equal(assertSafeShellCommand("npm test"), "npm test");
  assert.throws(() => parseSafeDevelopmentCommand("npm test"), /SANDORA_ALLOW_PACKAGE_SCRIPTS/);
  assert.throws(() => parseSafeDevelopmentCommand("npm exec --yes cowsay"), /not available/);
  const previousPackageAuthority = process.env.SANDORA_ALLOW_PACKAGE_SCRIPTS;
  process.env.SANDORA_ALLOW_PACKAGE_SCRIPTS = "1";
  assert.deepEqual(parseSafeDevelopmentCommand('npm run "test suite"'), { executable: "npm", args: ["run", "test suite"] });
  if (previousPackageAuthority === undefined) delete process.env.SANDORA_ALLOW_PACKAGE_SCRIPTS; else process.env.SANDORA_ALLOW_PACKAGE_SCRIPTS = previousPackageAuthority;
  for (const command of ["curl https://example.com", "npm test && whoami", "node -e process.exit()", "node %USERPROFILE%/secret.js", "node $HOME/secret.js", "node ../outside.js", "node C:\\outside.js", "python -m pip install bad"]) {
    assert.throws(() => parseSafeDevelopmentCommand(command), /allowlist|composition|Inline|workspace-relative|safety policy|Package|Python/);
  }
  const capped = await runBounded(process.execPath, ["-e", "process.stdout.write('x'.repeat(25000))"], { cwd: root });
  assert.match(capped.content[0].text, /output truncated/);
  const timed = await runBounded(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { cwd: root, timeoutMs: 20 });
  assert.equal(timed.details.timedOut, true);
  assert.equal(timed.details.cleanupReported, true);
  assert.equal(timed.details.cleanupVerified, false);
});

test("git observation is non-mutating and abort is reported", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-tools-"));
  await mkdir(join(root, ".git"));
  const controller = new AbortController();
  controller.abort();
  const result = await runBounded(process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? ["/c", "ping -n 5 127.0.0.1 > nul"] : ["-c", "sleep 5"], { cwd: root, signal: controller.signal, timeoutMs: 100 });
  assert.equal(result.details.aborted, true);
  assert.equal((await workspaceRoot(root)), root);
});

test("atomic replacement exposes only complete old or new content to readers", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-tools-"));
  const file = join(root, "shared.txt");
  const oldContent = "old-content\n".repeat(1000), newContent = "new-content\n".repeat(1000);
  await writeFile(file, oldContent);
  const reads = Array.from({ length: 4 }, async () => { for (let i = 0; i < 100; i += 1) { const value = await readFile(file, "utf8"); assert.ok(value === oldContent || value === newContent); } });
  for (let i = 0; i < 20; i += 1) await atomicReplaceFile(root, file, i % 2 ? oldContent : newContent);
  await Promise.all(reads);
});

test("publication failure preserves destination and cleans exclusive temp", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-tools-"));
  const file = join(root, "failure.txt");
  await writeFile(file, "old");
  await assert.rejects(() => atomicReplaceFile(root, file, "new", { publish: async () => { throw new Error("injected publication failure"); } }), /injected/);
  assert.equal(await readFile(file, "utf8"), "old");
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".sandora-") && name.endsWith(".tmp")), []);
});
