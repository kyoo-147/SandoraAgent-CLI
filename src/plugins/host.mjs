import { readdir, readFile, realpath } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const PLUGIN_API_VERSION = 1;
export const SANDORA_ENGINE_VERSION = "0.1.0";
export const CONTRIBUTION_TYPES = ["tool", "provider", "agent", "command", "service", "hook"];
// 0.x policy: a plugin must explicitly accept the running 0.x minor (or use *).
// Permissions are intentionally a small, host-mediated vocabulary; unknown values fail closed.
export const KNOWN_PERMISSIONS = new Set(["workspace.read", "workspace.write", "network", "process", "events.subscribe", "config.read", "services.use", "tools.register", "providers.register", "agents.register", "commands.register", "services.register", "hooks.register"]);
const MANIFEST_NAMES = ["sandora.plugin.json", "plugin.json"];
function issue(message) { return { valid: false, errors: [message] }; }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function assertPluginEntry(directory, entry) {
  const distance = relative(directory, entry);
  if (!distance || distance === ".." || distance.startsWith(`..${sep}`) || distance.startsWith(sep)) throw new Error("plugin entry must remain inside its plugin directory");
}
function list(value) { return Array.isArray(value) ? value : value && typeof value === "object" ? Object.keys(value) : []; }
function capabilityName(value) { return typeof value === "string" ? (value.endsWith("?") ? value.slice(0, -1) : value) : nonEmpty(value?.capability) ? value.capability : nonEmpty(value?.id) ? value.id : nonEmpty(value?.key) ? value.key : null; }
function targetRequires(value) {
  if (Array.isArray(value)) return value.map(item => typeof item === "string" ? { capability: capabilityName(item), optional: item.endsWith("?") } : { ...item, capability: capabilityName(item), optional: item?.optional === true });
  if (value && typeof value === "object") return Object.entries(value).map(([capability, requirement]) => ({ ...(requirement && typeof requirement === "object" ? requirement : {}), capability, optional: requirement?.optional === true || requirement === "optional" }));
  return [];
}
function targetProvides(value) {
  if (Array.isArray(value)) return [...new Set(value.map(capabilityName).filter(Boolean))];
  if (!value || typeof value !== "object") return [];
  return [...new Set([...(value.capabilities || []).map(capabilityName).filter(Boolean), ...CONTRIBUTION_TYPES.flatMap(type => list(value[`${type}s`] || value[type]).map(name => `${type}:${name}`))])];
}
function parseVersion(value) { const match = String(value).match(/^(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/); if (!match) return null; return { values: [Number(match[1]), match[2] && !/[xX*]/.test(match[2]) ? Number(match[2]) : null, match[3] && !/[xX*]/.test(match[3]) ? Number(match[3]) : null], specifiedMinor: Boolean(match[2]), specifiedPatch: Boolean(match[3]) }; }
function compare(a, b) { for (let i = 0; i < 3; i++) { const delta = a[i] - b[i]; if (delta) return delta; } return 0; }
function compatibleRange(range) {
  if (range === undefined || range === "*") return true;
  if (typeof range !== "string" || !range.trim()) return false;
  const current = [0, 1, 0];
  const test = token => { const match = token.match(/^(\^|~|>=|<=|>|<|=)?(.+)$/); if (!match) return false; const parsed = parseVersion(match[2]); if (!parsed) return false; const op = match[1] || "="; const base = parsed.values.map(value => value ?? 0); const cmp = compare(current, base);
    if (op === ">=") return cmp >= 0; if (op === ">") return cmp > 0; if (op === "<=") return cmp <= 0; if (op === "<") return cmp < 0;
    if (op === "^") { const upper = base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1]; return cmp >= 0 && compare(current, upper) < 0; }
    if (op === "~") { const upper = parsed.specifiedMinor ? [base[0], base[1] + 1, 0] : [base[0] + 1, 0, 0]; return cmp >= 0 && compare(current, upper) < 0; }
    return current[0] === base[0] && (parsed.values[1] == null || current[1] === base[1]) && (parsed.values[2] == null || current[2] === base[2]); };
  return range.split("||").some(part => { const tokens = part.trim().split(/\s+/).filter(Boolean); return tokens.length > 0 && tokens.every(test); });
}
function immutableClone(value, seen = new WeakMap()) { if (!value || typeof value !== "object") return value; if (seen.has(value)) return seen.get(value); const output = Array.isArray(value) ? [] : {}; seen.set(value, output); for (const [key, child] of Object.entries(value)) output[key] = immutableClone(child, seen); return Object.freeze(output); }

export function normalizeManifest(manifest) {
  if (manifest?.schemaVersion === 1) return { ...manifest, target: true, provides: targetProvides(manifest.provides), requires: targetRequires(manifest.requires) };
  return { ...manifest, target: false, provides: contributionNames(manifest), requires: [], permissions: [] };
}
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return issue("manifest must be an object");
  const errors = [];
  const target = manifest.schemaVersion === 1;
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!nonEmpty(manifest.id) || !/^[a-z][a-z0-9._-]*$/.test(manifest.id)) errors.push("id must match ^[a-z][a-z0-9._-]*$");
  if (!nonEmpty(manifest.version)) errors.push("version is required");
  if (target) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(manifest.version)) errors.push("version must be a complete semantic version");
    if (!manifest.engine || typeof manifest.engine.sandora !== "string" || !compatibleRange(manifest.engine.sandora)) errors.push("engine.sandora is incompatible with Sandora 0.x");
    if (!nonEmpty(manifest.entry)) errors.push("entry is required");
    if (manifest.provides !== undefined && !Array.isArray(manifest.provides) && (!manifest.provides || typeof manifest.provides !== "object")) errors.push("provides must be an array or object");
    if (manifest.requires !== undefined && !Array.isArray(manifest.requires) && (!manifest.requires || typeof manifest.requires !== "object")) errors.push("requires must be an array or object");
    if (manifest.permissions !== undefined && (!Array.isArray(manifest.permissions) || manifest.permissions.some(p => !KNOWN_PERMISSIONS.has(p)))) errors.push("permissions contains an unknown permission");
    if (manifest.configurationSchema !== undefined && (!manifest.configurationSchema || typeof manifest.configurationSchema !== "object" || Array.isArray(manifest.configurationSchema))) errors.push("configurationSchema must be an object");
    const refs = [...targetProvides(manifest.provides), ...targetRequires(manifest.requires).map(r => r?.capability)];
    if (refs.some(ref => !nonEmpty(ref) || !/^[a-z][a-z0-9._:-]*\??$/.test(ref))) errors.push("capability references must be non-empty identifiers");
  } else {
    if (!nonEmpty(manifest.name)) errors.push("name is required");
    if (manifest.api !== PLUGIN_API_VERSION) errors.push(`api must be ${PLUGIN_API_VERSION}`);
    if (!nonEmpty(manifest.entry)) errors.push("entry is required");
  }
  if (manifest.integrity !== undefined && (!manifest.integrity || manifest.integrity.algorithm !== "sha256" || !/^[a-f0-9]{64}$/.test(manifest.integrity.digest || ""))) errors.push("integrity must contain algorithm sha256 and a lowercase 64-character digest");
  if (manifest.contributes !== undefined) {
    if (!manifest.contributes || typeof manifest.contributes !== "object" || Array.isArray(manifest.contributes)) errors.push("contributes must be an object");
    else for (const [rawType, names] of Object.entries(manifest.contributes)) { const type = rawType.endsWith("s") ? rawType.slice(0, -1) : rawType; if (!CONTRIBUTION_TYPES.includes(type)) errors.push(`unknown contribution type: ${rawType}`); else if (!Array.isArray(names) || names.some(name => !nonEmpty(name))) errors.push(`${rawType} contributions must be non-empty strings`); }
  }
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] };
}
async function readManifest(directory) {
  for (const name of MANIFEST_NAMES) { const file = join(directory, name); if (!existsSync(file)) continue; try { const manifest = JSON.parse(await readFile(file, "utf8")); const checked = validateManifest(manifest); return { manifest, normalized: normalizeManifest(manifest), manifestPath: file, ...checked }; } catch (error) { return { valid: false, errors: [`invalid ${name}: ${error.message}`], manifestPath: file }; } }
  return null;
}
export async function discoverPlugins(directory) {
  const root = resolve(directory); const results = []; let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { return [{ valid: false, errors: [`cannot read plugin directory: ${error.message}`] }]; }
  for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".")) { const found = await readManifest(join(root, entry.name)); if (found) results.push({ ...found, directory: join(root, entry.name) }); }
  return results;
}
function contributionNames(manifest) { const output = []; for (const type of CONTRIBUTION_TYPES) for (const name of manifest.contributes?.[`${type}s`] || manifest.contributes?.[type] || []) output.push(`${type}:${name}`); return output; }
function requirements(plugin) { return plugin.normalized?.requires || []; }

export class PluginHost {
  constructor({ core = {}, enabled = [], logger = () => {}, services = {}, events = {}, config = {}, capabilities = [], permissionGrants = {} } = {}) {
    this.core = new Map(Object.entries(core).map(([key, value]) => [key.includes(":") ? key : `tool:${key}`, value])); this.enabled = new Set(enabled); this.logger = logger; this.plugins = new Map(); this.services = immutableClone(services); this.events = immutableClone(events); this.config = immutableClone(config); this.capabilities = new Set(capabilities); this.permissionGrants = new Map(Object.entries(permissionGrants).map(([id, values]) => { if (!Array.isArray(values) || values.some(value => !KNOWN_PERMISSIONS.has(value))) throw new Error(`invalid permission grants for plugin: ${id}`); return [id, new Set(values)]; })); this.activationOrder = []; this.registries = Object.fromEntries(CONTRIBUTION_TYPES.map(type => [type, new Map()]));
  }
  list() { return [...this.plugins.values()].map(({ manifest, state, error }) => ({ id: manifest?.id, state, error })); }
  contributions(type) { if (!CONTRIBUTION_TYPES.includes(type)) throw new Error(`unknown contribution type: ${type}`); return new Map(this.registries[type]); }
  async disposeAll() { for (const id of [...this.activationOrder].reverse()) { const plugin = this.plugins.get(id); if (plugin?.state === "active") await this.disposeInternal(plugin); } }
  enable(id) { this.enabled.add(id); return this.activate(id); }
  async disable(id, seen = new Set()) { const plugin = this.plugins.get(id); this.enabled.delete(id); if (!plugin || plugin.state !== "active" || seen.has(id)) return { id, state: "disabled" }; seen.add(id); for (const dependent of this.plugins.values()) if (dependent.state === "active" && requirements(dependent).some(req => !req.optional && plugin.normalized.provides.includes(req.capability))) await this.disable(dependent.manifest.id, seen); await this.disposeInternal(plugin); return { id, state: "disabled" }; }
  async load(discovered) {
    for (const item of discovered) { if (!item.valid || !item.manifest) { this.logger("plugin-invalid", item); continue; } if (this.plugins.has(item.manifest.id)) { item.valid = false; item.errors = ["duplicate plugin id"]; continue; } this.plugins.set(item.manifest.id, { ...item, state: "discovered" }); }
    const blocked = new Set();
    for (const id of this.enabled) { const plugin = this.plugins.get(id); if (!plugin) { this.logger("plugin-admission-failed", { id, error: new Error("unknown plugin") }); continue; } try { this.preflight(id); } catch (error) { for (const member of error.pluginPlan || this.dependencyGraph(id)) blocked.add(member); this.failed(plugin, error.message); this.logger("plugin-admission-failed", { id, error }); } }
    for (const id of this.enabled) if (!blocked.has(id)) await this.activate(id);
    return this.list();
  }
  admit(plugin, plannedCapabilities = []) {
    if (plugin.normalized.target && !compatibleRange(plugin.manifest.engine?.sandora)) throw new Error("incompatible Sandora engine range");
    const requested = new Set(plugin.normalized.target ? plugin.manifest.permissions || [] : []); const granted = this.permissionGrants.get(plugin.manifest.id) || new Set(); for (const permission of requested) if (!granted.has(permission)) throw new Error(`permission not granted: ${permission}`);
    const available = new Set([...this.availableCapabilities(), ...plannedCapabilities]);
    for (const req of requirements(plugin)) if (!req?.optional && !available.has(String(req.capability).replace(/\?$/, ""))) throw new Error(`missing required capability: ${req?.capability}`);
  }
  availableCapabilities() { const available = new Set([...this.capabilities, ...this.core.keys()]); for (const plugin of this.plugins.values()) if (plugin.state === "active") for (const capability of plugin.normalized?.provides || []) available.add(capability); return available; }
  dependencyGraph(id, seen = new Set()) { if (seen.has(id)) return seen; seen.add(id); const plugin = this.plugins.get(id); for (const requirement of requirements(plugin || {})) for (const candidate of this.plugins.values()) if (candidate.manifest.id !== id && this.enabled.has(candidate.manifest.id) && candidate.normalized.provides.includes(requirement.capability)) this.dependencyGraph(candidate.manifest.id, seen); return seen; }
  preflight(id) { let plan; try { plan = this.order(id); const planned = new Set(); for (const item of plan) { const plugin = this.plugins.get(item); if (!plugin) throw new Error(`Unknown plugin: ${item}`); if (plugin.state === "active") continue; this.admit(plugin, planned); for (const capability of plugin.normalized.provides) planned.add(capability); } return plan; } catch (error) { error.pluginPlan = plan || [...this.dependencyGraph(id)]; throw error; } }
  order(id, visiting = new Set(), done = new Set(), output = []) {
    if (done.has(id)) return output; if (visiting.has(id)) throw new Error("plugin dependency cycle"); visiting.add(id); const p = this.plugins.get(id); for (const req of requirements(p || {})) if (!req.optional && !this.capabilities.has(req.capability) && !this.core.has(req.capability)) { const candidates = [...this.plugins.values()].filter(candidate => candidate.manifest.id !== id && this.enabled.has(candidate.manifest.id) && candidate.normalized.provides.includes(req.capability)); if (candidates.length > 1) throw new Error(`ambiguous capability provider: ${req.capability}`); if (candidates.length === 1) this.order(candidates[0].manifest.id, visiting, done, output); } visiting.delete(id); done.add(id); output.push(id); return output;
  }
  async activate(id) {
    const plugin = this.plugins.get(id); if (!plugin) return { id, state: "failed", error: "unknown plugin" }; if (plugin.state === "active") return { id, state: "active" };
    let order; try { order = this.preflight(id); } catch (error) { return this.failed(plugin, error.message); }
    const initiallyActive = new Set(order.filter(item => this.plugins.get(item)?.state === "active"));
    for (const next of order) { const item = this.plugins.get(next); if (item.state === "active") continue; try { await this.activateOne(item); } catch (error) { this.failed(item, error.message); for (const activeId of order.slice().reverse()) if (!initiallyActive.has(activeId) && this.plugins.get(activeId)?.state === "active") await this.disposeInternal(this.plugins.get(activeId)); if (next !== id) return this.failed(plugin, `dependency failed: ${item.manifest.id}`); return this.list().find(x => x.id === id); } }
    return { id, state: "active" };
  }
  async activateOne(plugin) {
    const id = plugin.manifest.id; const names = contributionNames(plugin.manifest); const declared = new Set([...names, ...plugin.normalized.provides]); const added = []; const disposables = [];
    const cleanup = async record => { if (record.done) return; record.done = true; try { await record.fn?.(); } catch (error) { this.logger("plugin-cleanup-failed", { id, error }); } };
    const register = disposable => { const fn = typeof disposable === "function" ? disposable : disposable && typeof disposable.dispose === "function" ? () => disposable.dispose() : null; if (!fn) throw new Error("register requires a disposable function or object"); const record = { fn, done: false }; disposables.push(record); return () => cleanup(record); };
    const permissions = new Set(plugin.normalized.target ? plugin.manifest.permissions || [] : KNOWN_PERMISSIONS); const granted = plugin.normalized.target ? (this.permissionGrants.get(id) || new Set()) : KNOWN_PERMISSIONS; const allowed = permission => { if (!permissions.has(permission) || !granted.has(permission)) throw new Error(`permission not granted: ${permission}`); }; const can = permission => permissions.has(permission) && granted.has(permission);
    const capabilityValues = Object.freeze([...new Set([...this.availableCapabilities(), ...plugin.normalized.provides])]);
    const api = { register, pluginId: id, services: can("services.use") ? this.services : Object.freeze({}), events: can("events.subscribe") ? this.events : Object.freeze({}), config: can("config.read") ? this.config : Object.freeze({}), capabilities: Object.freeze({ has: value => capabilityValues.includes(value), list: () => capabilityValues }) };
    Object.defineProperty(api, "context", { value: api, enumerable: true });
    for (const type of CONTRIBUTION_TYPES) {
      const method = type === "hook" ? "registerHook" : `register${type[0].toUpperCase()}${type.slice(1)}`;
      api[method] = (name, value) => {
        if (!declared.has(`${type}:${name}`)) throw new Error(`undeclared contribution: ${type}:${name}`);
        if (!name || this.core.has(`${type}:${name}`) || this.registries[type].has(name) || added.some(e => e.type === type && e.name === name)) throw new Error(`contribution collision: ${type}:${name}`);
        const permission = { tool: "tools.register", provider: "providers.register", agent: "agents.register", command: "commands.register", service: "services.register", hook: "hooks.register" }[type]; allowed(permission); this.registries[type].set(name, { plugin: id, value });
        const record = { type, name, done: false, fn: () => { if (this.registries[type].get(name)?.plugin === id) this.registries[type].delete(name); } };
        added.push(record); disposables.push(record); return () => cleanup(record);
      };
    }
    Object.freeze(api);
    try { const requested = resolve(plugin.directory, plugin.manifest.entry); assertPluginEntry(plugin.directory, requested); const entry = await realpath(requested); assertPluginEntry(await realpath(plugin.directory), entry); if (plugin.manifest.integrity) { const actual = createHash("sha256").update(await readFile(entry)).digest(); const expected = Buffer.from(plugin.manifest.integrity.digest, "hex"); if (!timingSafeEqual(actual, expected)) throw new Error("plugin entry integrity mismatch"); } const module = await import(pathToFileURL(entry).href); if (typeof module.activate !== "function") throw new Error("entry must export activate(api)"); const result = await module.activate(api); const disposer = typeof result === "function" ? result : module.dispose; if (typeof disposer === "function") disposables.push({ fn: disposer, done: false }); plugin.cleanup = cleanup; plugin.added = disposables; plugin.state = "active"; this.activationOrder.push(id); } catch (error) { for (const record of disposables.slice().reverse()) await cleanup(record); throw error; }
  }
  async disposeInternal(plugin) { for (const record of (plugin.added || []).slice().reverse()) await plugin.cleanup?.(record); plugin.added = []; plugin.cleanup = null; plugin.state = "disabled"; this.activationOrder = this.activationOrder.filter(id => id !== plugin.manifest.id); }
  failed(plugin, error) { plugin.state = "failed"; plugin.error = error; return { id: plugin.manifest.id, state: "failed", error }; }
}
