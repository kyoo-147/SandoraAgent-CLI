import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlugins, PluginHost, validateManifest } from "../../src/plugins/host.mjs";

const manifest = (id, entry = "index.mjs", contributes = { tools: ["hello"], providers: ["local"], agents: ["review"], commands: ["greet"], services: ["clock"], hooks: ["startup"] }) => ({ id, name: id, version: "1.0.0", api: 1, entry, contributes });

async function fixture(root, id, code, value = manifest(id)) {
  const dir = join(root, id);
  await mkdir(dir);
  await writeFile(join(dir, "sandora.plugin.json"), JSON.stringify(value));
  await writeFile(join(dir, value.entry), code);
}

test("validates manifests and rejects malformed contracts", () => {
  assert.equal(validateManifest(manifest("demo")).valid, true);
  assert.equal(validateManifest({ id: "Bad ID", api: 2 }).valid, false);
  assert.match(validateManifest({ id: "demo", name: "x", version: "1", api: 1, entry: "x", contributes: { widgets: ["x"] } }).errors.join(" "), /unknown contribution/);
});

test("discovers fixture plugins and safely reports malformed entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugins-"));
  try {
    await fixture(root, "good", "export async function activate() {}\n");
    await mkdir(join(root, "broken"));
    await writeFile(join(root, "broken", "sandora.plugin.json"), "{not json");
    const found = await discoverPlugins(root);
    assert.equal(found.length, 2);
    assert.equal(found.find((x) => x.manifest?.id === "good").valid, true);
    assert.equal(found.find((x) => !x.valid).valid, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("activates all contribution kinds transactionally, then disposes on disable", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugins-"));
  try {
    await fixture(root, "demo", `export async function activate(api) {
      api.registerTool("hello", { run: () => "ok" }); api.registerProvider("local", {});
      api.registerAgent("review", {}); api.registerCommand("greet", {}); api.registerService("clock", {}); api.registerHook("startup", {});
      return () => globalThis.__disposed = true;
    }`);
    const host = new PluginHost({ enabled: ["demo"] });
    await host.load(await discoverPlugins(root));
    assert.equal(host.list()[0].state, "active");
    for (const type of ["tool", "provider", "agent", "command", "service", "hook"]) assert.equal(host.contributions(type).size, 1);
    await host.disable("demo");
    assert.equal(globalThis.__disposed, true);
    for (const type of ["tool", "provider", "agent", "command", "service", "hook"]) assert.equal(host.contributions(type).size, 0);
  } finally { delete globalThis.__disposed; await rm(root, { recursive: true, force: true }); }
});

test("rejects collisions and rolls back partial activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugins-"));
  try {
    await fixture(root, "one", "export function activate(api) { api.registerTool(\"shared\", {}); }", manifest("one", "index.mjs", { tools: ["shared"] }));
    await fixture(root, "two", "export function activate(api) { api.registerTool(\"shared\", {}); throw new Error(\"boom\"); }", manifest("two", "index.mjs", { tools: ["shared"] }));
    const host = new PluginHost({ enabled: ["one", "two"], core: { "tool:core": {} } });
    await host.load(await discoverPlugins(root));
    assert.equal(host.list().find((x) => x.id === "one").state, "active");
    assert.equal(host.list().find((x) => x.id === "two").state, "failed");
    assert.equal(host.contributions("tool").size, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("plugin entry cannot escape its plugin directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugins-"));
  try {
    const directory = join(root, "escape");
    await mkdir(directory);
    await writeFile(join(root, "outside.mjs"), "globalThis.__escapedPlugin = true; export function activate() {}\n");
    await writeFile(join(directory, "sandora.plugin.json"), JSON.stringify(manifest("escape", "../outside.mjs", {})));
    const host = new PluginHost({ enabled: ["escape"] });
    await host.load(await discoverPlugins(root));
    assert.equal(host.list()[0].state, "failed");
    assert.match(host.list()[0].error, /inside its plugin directory/);
    assert.equal(globalThis.__escapedPlugin, undefined);
  } finally {
    delete globalThis.__escapedPlugin;
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects undeclared contributions and disposes all active plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugins-"));
  try {
    await fixture(root, "strict", `export function activate(api) { api.registerTool("other", {}); }`, manifest("strict", "index.mjs", { tools: ["declared"] }));
    const strict = new PluginHost({ enabled: ["strict"] });
    await strict.load(await discoverPlugins(root));
    assert.match(strict.list()[0].error, /undeclared contribution/);

    await fixture(root, "owned", `export function activate(api) { api.registerTool("owned", {}); return () => { globalThis.__pluginDisposeCount = (globalThis.__pluginDisposeCount || 0) + 1; }; }`, manifest("owned", "index.mjs", { tools: ["owned"] }));
    const owned = new PluginHost({ enabled: ["owned"] });
    await owned.load(await discoverPlugins(root));
    await owned.disposeAll();
    await owned.disposeAll();
    assert.equal(globalThis.__pluginDisposeCount, 1);
  } finally { delete globalThis.__pluginDisposeCount; await rm(root, { recursive: true, force: true }); }
});
