import { resolve } from "node:path";
import { defineTool } from "../tools/registry.mjs";
import { assertProvider } from "../runtime/turn-runtime.mjs";
import { discoverPlugins, KNOWN_PERMISSIONS, PluginHost } from "./host.mjs";

const PLUGIN_ID = /^[a-z][a-z0-9._-]*$/;

export function configuredPluginIds(value = process.env.SANDORA_PLUGINS || "") {
  const ids = [...new Set(String(value).split(",").map(item => item.trim()).filter(Boolean))];
  for (const id of ids) if (!PLUGIN_ID.test(id)) throw new Error(`Invalid configured Sandora plugin id: ${id}`);
  return ids;
}

export function configuredPluginPermissionGrants(value = process.env.SANDORA_PLUGIN_PERMISSION_GRANTS || "") {
  if (!value) return {};
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("SANDORA_PLUGIN_PERMISSION_GRANTS must be a JSON object"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SANDORA_PLUGIN_PERMISSION_GRANTS must be a JSON object");
  const output = {};
  for (const [id, permissions] of Object.entries(parsed)) {
    if (!PLUGIN_ID.test(id) || !Array.isArray(permissions) || permissions.some(permission => !KNOWN_PERMISSIONS.has(permission))) throw new Error(`Invalid configured permission grants for plugin: ${id}`);
    output[id] = [...new Set(permissions)];
  }
  return output;
}

export async function loadSessionPlugins({ cwd, enabled = configuredPluginIds(), coreTools = [], providerName = process.env.SANDORA_PROVIDER_PLUGIN, permissionGrants = configuredPluginPermissionGrants() } = {}) {
  if (!enabled.length && !providerName) return { host: null, tools: [], provider: undefined, dispose: async () => {} };
  if (!enabled.length) throw new Error("SANDORA_PROVIDER_PLUGIN requires the provider plugin to be explicitly enabled in SANDORA_PLUGINS");
  const core = Object.fromEntries(coreTools.map(tool => [`tool:${tool.name}`, tool]));
  const host = new PluginHost({ core, enabled, permissionGrants });
  try {
    await host.load(await discoverPlugins(resolve(cwd, ".sandora", "plugins")));
    const states = new Map(host.list().map(plugin => [plugin.id, plugin]));
    for (const id of enabled) {
      const plugin = states.get(id);
      if (!plugin || plugin.state !== "active") throw new Error(`Configured Sandora plugin failed to activate: ${id}${plugin?.error ? ` (${plugin.error})` : ""}`);
    }
    const tools = [...host.contributions("tool")].map(([name, entry]) => {
      const value = entry.value;
      if (!value || typeof value !== "object" || (value.name && value.name !== name)) throw new Error(`Plugin tool contract is invalid: ${entry.plugin}/${name}`);
      return defineTool({ ...value, name });
    });
    let provider;
    if (providerName) {
      const entry = host.contributions("provider").get(providerName);
      if (!entry) throw new Error(`Unknown enabled Sandora provider plugin: ${providerName}`);
      const contribution = entry.value;
      provider = typeof contribution === "function" ? await contribution({ cwd }) : typeof contribution?.create === "function" ? await contribution.create({ cwd }) : contribution;
      assertProvider(provider);
    }
    let disposed = false;
    return { host, tools, provider, dispose: async () => {
      if (disposed) return;
      disposed = true;
      try { if (typeof provider?.dispose === "function") await provider.dispose(); }
      finally { await host.disposeAll(); }
    } };
  } catch (error) {
    await host.disposeAll();
    throw error;
  }
}
