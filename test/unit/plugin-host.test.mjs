import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlugins, PluginHost, validateManifest } from "../../src/plugins/host.mjs";

const manifest = (id, entry = "index.mjs", contributes = { tools: ["hello"], providers: ["local"], agents: ["review"], commands: ["greet"], services: ["clock"], hooks: ["startup"] }) => ({ id, name: id, version: "1.0.0", api: 1, entry, contributes });
const targetManifest = (id, overrides = {}) => ({ schemaVersion: 1, id, version: "1.0.0", engine: { sandora: "^0.1.0" }, entry: "index.mjs", provides: [], requires: [], permissions: [], ...overrides });

async function fixture(root, id, code, value = manifest(id)) {
  const dir = join(root, id);
  await mkdir(dir);
  await writeFile(join(dir, "sandora.plugin.json"), JSON.stringify(value));
  await writeFile(join(dir, value.entry), code);
}

test("validates manifests and rejects malformed contracts", () => {
  assert.equal(validateManifest(manifest("demo")).valid, true);
  assert.equal(validateManifest({ id: "Bad ID", api: 2 }).valid, false);
  assert.match(validateManifest({ ...manifest("demo"), integrity: { algorithm: "sha256", digest: "bad" } }).errors.join(" "), /integrity/);
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

test("optional plugin entry integrity is verified before code executes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugin-integrity-"));
  try {
    const code = "globalThis.__integrityPlugin = true; export function activate() {}\n";
    const digest = createHash("sha256").update(code).digest("hex");
    await fixture(root, "sealed", code, { ...manifest("sealed", "index.mjs", {}), integrity: { algorithm: "sha256", digest } });
    await writeFile(join(root, "sealed", "index.mjs"), `${code}// tampered`);
    const host = new PluginHost({ enabled: ["sealed"] });
    await host.load(await discoverPlugins(root));
    assert.equal(host.list()[0].state, "failed");
    assert.match(host.list()[0].error, /integrity mismatch/);
    assert.equal(globalThis.__integrityPlugin, undefined);
  } finally { delete globalThis.__integrityPlugin; await rm(root, { recursive: true, force: true }); }
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

test("validates target V1 manifests and anchored 0.x engine ranges", () => {
  for (const range of ["0.1.0", "0.1.x", "^0.1.0", "~0.1.0", ">=0.1.0 <0.2.0", "<0.2.0", "<=0.1.0", ">=0.2.0 || =0.1.0"]) assert.equal(validateManifest(targetManifest("target", { engine: { sandora: range } })).valid, true, range);
  for (const range of ["0.2.0", ">0.1.0", "<0.1.0", "^0.2.0", "0.1.0 trailing"]) assert.equal(validateManifest(targetManifest("target", { engine: { sandora: range } })).valid, false, range);
  assert.equal(validateManifest(targetManifest("target", { permissions: ["unknown"] })).valid, false);
  assert.equal(validateManifest(targetManifest("target", { version: "v1.2.3" })).valid, false);
  assert.equal(validateManifest(targetManifest("target", { version: "1.2.3-beta.1+build.7" })).valid, true);
  assert.equal(validateManifest(targetManifest("target", { configurationSchema: [] })).valid, false);
  assert.equal(validateManifest({ ...targetManifest("target"), schemaVersion: 2 }).valid, false);
});

test("target permission denial occurs before import and granted context is immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugin-target-"));
  try {
    await fixture(root, "denied", "globalThis.__targetImported = true; export function activate() {}", targetManifest("denied", { permissions: ["network"] }));
    const denied = new PluginHost({ enabled: ["denied"] }); await denied.load(await discoverPlugins(root));
    assert.equal(denied.list()[0].state, "failed"); assert.equal(globalThis.__targetImported, undefined);
    const config = { nested: { value: 1 } }, services = { nested: { ready: true } }, events = { nested: { name: "bus" } };
    await fixture(root, "granted", `export function activate(ctx) {
      globalThis.__targetContext = { pluginId: ctx.pluginId, configFrozen: Object.isFrozen(ctx.config.nested), servicesFrozen: Object.isFrozen(ctx.services.nested), eventsFrozen: Object.isFrozen(ctx.events.nested), caps: ctx.capabilities.list(), mutableAdd: typeof ctx.capabilities.add };
      try { ctx.config.nested.value = 9; } catch {}
      ctx.registerTool("target_tool", {});
    }`, targetManifest("granted", { provides: ["tool:target_tool"], permissions: ["tools.register", "config.read", "services.use", "events.subscribe"] }));
    const granted = new PluginHost({ enabled: ["granted"], config, services, events, capabilities: ["core:one"], permissionGrants: { granted: ["tools.register", "config.read", "services.use", "events.subscribe"] } });
    await granted.load(await discoverPlugins(root));
    assert.equal(granted.list().find(item => item.id === "granted").state, "active"); assert.deepEqual(globalThis.__targetContext, { pluginId: "granted", configFrozen: true, servicesFrozen: true, eventsFrozen: true, caps: ["core:one", "tool:target_tool"], mutableAdd: "undefined" });
    assert.equal(config.nested.value, 1, "context freezing must not mutate caller-owned input");
  } finally { delete globalThis.__targetImported; delete globalThis.__targetContext; await rm(root, { recursive: true, force: true }); }
});

test("all enabled plugin graphs pass admission before any dependency import", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugin-global-admission-"));
  try {
    await fixture(root, "admission-provider", "globalThis.__admissionProviderImported = true; export function activate() {}", targetManifest("admission-provider", { provides: ["cap:admission"] }));
    await fixture(root, "denied-consumer", "globalThis.__deniedConsumerImported = true; export function activate() {}", targetManifest("denied-consumer", { requires: ["cap:admission"], permissions: ["network"] }));
    const host = new PluginHost({ enabled: ["denied-consumer", "admission-provider"] }); await host.load(await discoverPlugins(root));
    assert.equal(host.list().find(item => item.id === "denied-consumer").state, "failed"); assert.equal(globalThis.__admissionProviderImported, undefined); assert.equal(globalThis.__deniedConsumerImported, undefined);
  } finally { delete globalThis.__admissionProviderImported; delete globalThis.__deniedConsumerImported; await rm(root, { recursive: true, force: true }); }
});

test("target dependencies activate in order and disable consumers before providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugin-deps-")); globalThis.__pluginOrder = [];
  try {
    await fixture(root, "consumer", `export function activate(ctx) { globalThis.__pluginOrder.push("consumer:start"); ctx.register(() => globalThis.__pluginOrder.push("consumer:stop")); }`, targetManifest("consumer", { requires: ["cap:provider"] }));
    await fixture(root, "provider", `export function activate(ctx) { globalThis.__pluginOrder.push("provider:start"); ctx.register(() => globalThis.__pluginOrder.push("provider:stop")); }`, targetManifest("provider", { provides: ["cap:provider"] }));
    const host = new PluginHost({ enabled: ["consumer", "provider"] }); await host.load(await discoverPlugins(root));
    assert.deepEqual(globalThis.__pluginOrder, ["provider:start", "consumer:start"]);
    await host.disable("provider");
    assert.deepEqual(globalThis.__pluginOrder, ["provider:start", "consumer:start", "consumer:stop", "provider:stop"]);
    assert.deepEqual(host.list().map(item => item.state), ["disabled", "disabled"]);
  } finally { delete globalThis.__pluginOrder; await rm(root, { recursive: true, force: true }); }
});

test("target optional requirements activate while cycles fail before import", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugin-cycle-"));
  try {
    await fixture(root, "optional", "globalThis.__optionalActivated = true; export function activate() {}", targetManifest("optional", { requires: [{ capability: "cap:missing", optional: true }] }));
    await fixture(root, "cycle-a", "globalThis.__cycleImported = true; export function activate() {}", targetManifest("cycle-a", { provides: ["cap:a"], requires: ["cap:b"] }));
    await fixture(root, "cycle-b", "globalThis.__cycleImported = true; export function activate() {}", targetManifest("cycle-b", { provides: ["cap:b"], requires: ["cap:a"] }));
    const host = new PluginHost({ enabled: ["optional", "cycle-a", "cycle-b"] }); await host.load(await discoverPlugins(root));
    assert.equal(host.list().find(item => item.id === "optional").state, "active"); assert.equal(globalThis.__optionalActivated, true);
    assert.notEqual(host.list().find(item => item.id === "cycle-a").state, "active"); assert.equal(globalThis.__cycleImported, undefined);
  } finally { delete globalThis.__optionalActivated; delete globalThis.__cycleImported; await rm(root, { recursive: true, force: true }); }
});

test("ambiguous hard capability providers fail before any module import", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugin-ambiguous-"));
  try {
    for (const id of ["provider-one", "provider-two"]) await fixture(root, id, "export function activate() {}", targetManifest(id, { provides: ["cap:shared"] }));
    await fixture(root, "consumer-ambiguous", "globalThis.__ambiguousImported = true; export function activate() {}", targetManifest("consumer-ambiguous", { requires: ["cap:shared"] }));
    const host = new PluginHost({ enabled: ["consumer-ambiguous", "provider-one", "provider-two"] }); await host.load(await discoverPlugins(root));
    assert.notEqual(host.list().find(item => item.id === "consumer-ambiguous").state, "active"); assert.equal(globalThis.__ambiguousImported, undefined);
  } finally { delete globalThis.__ambiguousImported; await rm(root, { recursive: true, force: true }); }
});

test("registered and returned disposables unwind once in reverse order", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugin-dispose-")); globalThis.__disposeOrder = [];
  try {
    await fixture(root, "cleanup", `export function activate(ctx) { ctx.register(() => globalThis.__disposeOrder.push("one")); ctx.register(() => globalThis.__disposeOrder.push("two")); return () => globalThis.__disposeOrder.push("returned"); }`, targetManifest("cleanup"));
    const host = new PluginHost({ enabled: ["cleanup"] }); await host.load(await discoverPlugins(root)); await host.disposeAll(); await host.disposeAll();
    assert.deepEqual(globalThis.__disposeOrder, ["returned", "two", "one"]);
  } finally { delete globalThis.__disposeOrder; await rm(root, { recursive: true, force: true }); }
});
