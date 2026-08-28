import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeShellCommand, createCodingTools, filteredEnvironment, runBounded, workspaceRoot } from "../../src/tools/coding-tools.mjs";

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
  const command = process.platform === "win32" ? "echo %OPENAI_API_KEY%" : "printf '%s' \"$OPENAI_API_KEY\"";
  const result = await tool("workspace_shell").execute("1", { command }, null, null, context(root));
  assert.match(result.content[0].text, /exit 0/);
  assert.ok(!result.content[0].text.includes("do-not-pass"));
  assert.throws(() => assertSafeShellCommand("shutdown /s"), /safety policy/);
  assert.throws(() => assertSafeShellCommand("cd ../outside"), /safety policy/);
  assert.throws(() => assertSafeShellCommand("C:\\Windows\\System32\\cmd.exe"), /safety policy/);
  assert.equal(assertSafeShellCommand("npm test"), "npm test");
  const capped = await runBounded(process.execPath, ["-e", "process.stdout.write('x'.repeat(25000))"], { cwd: root });
  assert.match(capped.content[0].text, /output truncated/);
  const timed = await runBounded(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { cwd: root, timeoutMs: 20 });
  assert.equal(timed.details.timedOut, true);
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
