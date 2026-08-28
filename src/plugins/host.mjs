import { readdir, readFile, realpath } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const PLUGIN_API_VERSION = 1;
export const CONTRIBUTION_TYPES = ["tool", "provider", "agent", "command", "service", "hook"];
const MANIFEST_NAMES = ["sandora.plugin.json", "plugin.json"];

function issue(message) { return { valid: false, errors: [message] }; }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }

function assertPluginEntry(directory, entry) {
  const distance = relative(directory, entry);
  if (!distance || distance === ".." || distance.startsWith(`..${sep}`) || distance.startsWith(sep)) throw new Error("plugin entry must remain inside its plugin directory");
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return issue("manifest must be an object");
  const errors = [];
  if (!nonEmpty(manifest.id) || !/^[a-z][a-z0-9._-]*$/.test(manifest.id)) errors.push("id must match ^[a-z][a-z0-9._-]*$");
  if (!nonEmpty(manifest.name)) errors.push("name is required");
  if (!nonEmpty(manifest.version)) errors.push("version is required");
  if (manifest.api !== PLUGIN_API_VERSION) errors.push(`api must be ${PLUGIN_API_VERSION}`);
  if (!nonEmpty(manifest.entry)) errors.push("entry is required");
  if (manifest.integrity !== undefined && (!manifest.integrity || manifest.integrity.algorithm !== "sha256" || !/^[a-f0-9]{64}$/.test(manifest.integrity.digest || ""))) errors.push("integrity must contain algorithm sha256 and a lowercase 64-character digest");
  if (manifest.contributes !== undefined) {
    if (!manifest.contributes || typeof manifest.contributes !== "object" || Array.isArray(manifest.contributes)) errors.push("contributes must be an object");
    else for (const [rawType, names] of Object.entries(manifest.contributes)) {
      const type = rawType.endsWith("s") ? rawType.slice(0, -1) : rawType;
      if (!CONTRIBUTION_TYPES.includes(type)) errors.push(`unknown contribution type: ${rawType}`);
      else if (!Array.isArray(names) || names.some((name) => !nonEmpty(name))) errors.push(`${rawType} contributions must be non-empty strings`);
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] };
}

async function readManifest(directory) {
  for (const name of MANIFEST_NAMES) {
    const file = join(directory, name);
    if (!existsSync(file)) continue;
    try {
      const manifest = JSON.parse(await readFile(file, "utf8"));
      const checked = validateManifest(manifest);
      return { manifest, manifestPath: file, ...checked };
    } catch (error) { return { valid: false, errors: [`invalid ${name}: ${error.message}`], manifestPath: file }; }
  }
  return null;
}

export async function discoverPlugins(directory) {
  const root = resolve(directory);
  const results = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { return [{ valid: false, errors: [`cannot read plugin directory: ${error.message}`] }]; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const found = await readManifest(join(root, entry.name));
    if (found) results.push({ ...found, directory: join(root, entry.name) });
  }
  return results;
}

function contributionNames(manifest) {
  const output = [];
  for (const type of CONTRIBUTION_TYPES) for (const name of manifest.contributes?.[`${type}s`] || manifest.contributes?.[type] || []) output.push(`${type}:${name}`);
  return output;
}

export class PluginHost {
  constructor({ core = {}, enabled = [], logger = () => {} } = {}) {
    this.core = new Map(Object.entries(core).map(([key, value]) => [key.includes(":") ? key : `tool:${key}`, value]));
    this.enabled = new Set(enabled);
    this.logger = logger;
    this.plugins = new Map();
    this.registries = Object.fromEntries(CONTRIBUTION_TYPES.map((type) => [type, new Map()]));
  }

  list() { return [...this.plugins.values()].map(({ manifest, state, error }) => ({ id: manifest?.id, state, error })); }
  contributions(type) { if (!CONTRIBUTION_TYPES.includes(type)) throw new Error(`unknown contribution type: ${type}`); return new Map(this.registries[type]); }
  async disposeAll() {
    for (const plugin of [...this.plugins.values()].reverse()) if (plugin.state === "active") await this.#dispose(plugin);
  }
  enable(id) { this.enabled.add(id); return this.activate(id); }
  async disable(id) {
    const plugin = this.plugins.get(id);
    this.enabled.delete(id);
    if (!plugin || plugin.state !== "active") return { id, state: "disabled" };
    await this.#dispose(plugin);
    return { id, state: "disabled" };
  }

  async load(discovered) {
    const valid = discovered.filter((item) => item.valid && item.manifest);
    const ids = new Set();
    for (const item of discovered) {
      if (!item.valid || !item.manifest) { this.logger("plugin-invalid", item); continue; }
      if (ids.has(item.manifest.id) || this.plugins.has(item.manifest.id)) { item.valid = false; item.errors = ["duplicate plugin id"]; continue; }
      ids.add(item.manifest.id);
      this.plugins.set(item.manifest.id, { ...item, state: "discovered" });
    }
    for (const item of valid) if (item.valid && this.enabled.has(item.manifest.id)) await this.activate(item.manifest.id);
    return this.list();
  }

  async activate(id) {
    const plugin = this.plugins.get(id);
    if (!plugin) return { id, state: "failed", error: "unknown plugin" };
    if (plugin.state === "active") return { id, state: "active" };
    const names = contributionNames(plugin.manifest);
    const declared = new Set(names);
    const seen = new Set();
    const collisions = names.filter((key) => seen.has(key) || this.core.has(key) || [...this.registries[key.split(":")[0]].keys()].includes(key.slice(key.indexOf(":") + 1)) || !seen.add(key));
    if (collisions.length) return this.#failed(plugin, `contribution collision: ${[...new Set(collisions)].join(", ")}`);
    const added = [];
    const api = Object.fromEntries(CONTRIBUTION_TYPES.map((type) => [type === "hook" ? "registerHook" : `register${type[0].toUpperCase()}${type.slice(1)}`, (name, value) => {
      if (!declared.has(`${type}:${name}`)) throw new Error(`undeclared contribution: ${type}:${name}`);
      if (!nonEmpty(name) || this.core.has(`${type}:${name}`) || this.registries[type].has(name) || added.some((entry) => entry.type === type && entry.name === name)) throw new Error(`contribution collision: ${type}:${name}`);
      this.registries[type].set(name, { plugin: id, value }); added.push({ type, name });
      return () => { if (this.registries[type].get(name)?.plugin === id) this.registries[type].delete(name); };
    }]));
    try {
      const requestedEntry = resolve(plugin.directory, plugin.manifest.entry);
      assertPluginEntry(plugin.directory, requestedEntry);
      const entry = await realpath(requestedEntry);
      assertPluginEntry(await realpath(plugin.directory), entry);
      if (plugin.manifest.integrity) {
        const actual = createHash("sha256").update(await readFile(entry)).digest();
        const expected = Buffer.from(plugin.manifest.integrity.digest, "hex");
        if (!timingSafeEqual(actual, expected)) throw new Error("plugin entry integrity mismatch");
      }
      const module = await import(pathToFileURL(entry).href);
      if (typeof module.activate !== "function") throw new Error("entry must export activate(api)");
      const result = await module.activate(api);
      plugin.dispose = typeof result === "function" ? result : module.dispose;
      plugin.added = added;
      plugin.state = "active";
      return { id, state: "active" };
    } catch (error) {
      for (const entry of added) this.registries[entry.type].delete(entry.name);
      return this.#failed(plugin, error.message);
    }
  }

  async #dispose(plugin) {
    try { if (typeof plugin.dispose === "function") await plugin.dispose(); } catch (error) { this.logger("plugin-dispose-failed", { id: plugin.manifest.id, error }); }
    for (const entry of plugin.added || []) if (this.registries[entry.type].get(entry.name)?.plugin === plugin.manifest.id) this.registries[entry.type].delete(entry.name);
    plugin.added = []; plugin.dispose = null; plugin.state = "disabled";
  }
  #failed(plugin, error) { plugin.state = "failed"; plugin.error = error; return { id: plugin.manifest.id, state: "failed", error }; }
}