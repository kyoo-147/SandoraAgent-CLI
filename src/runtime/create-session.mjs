import { randomUUID } from "node:crypto";
import { createAgentSession as createNativeAgentSession } from "./native-agent-session.mjs";
import { NativeToolRegistry } from "../tools/registry.mjs";
import { assertAgentSession, withRunLifecycle } from "./agent-session.mjs";
import { configuredPluginIds, configuredPluginPermissionGrants, loadSessionPlugins } from "../plugins/runtime.mjs";
import { cleanupBrowserSessions } from "../browser/tools.mjs";

export const DEFAULT_AGENT_CORE = "pi";

export async function createSandoraSession({
  core = process.env.SANDORA_AGENT_CORE || DEFAULT_AGENT_CORE,
  customTools = [],
  pluginIds = configuredPluginIds(),
  providerPlugin = process.env.SANDORA_PROVIDER_PLUGIN,
  pluginPermissionGrants = configuredPluginPermissionGrants(),
  resourceOwnerId = randomUUID(),
  ...options
} = {}) {
  if (!['pi', 'native'].includes(core)) throw new Error(`Unsupported SANDORA_AGENT_CORE: ${core}. Expected pi or native.`);
  if (core === "pi" && providerPlugin) throw new Error("Plugin providers are supported by the native runtime only; Pi providers must be configured through Pi ModelRuntime");
  if (typeof resourceOwnerId !== "string" || !resourceOwnerId) throw new Error("Sandora resource owner identity is required");
  const plugins = await loadSessionPlugins({ cwd: options.cwd || process.cwd(), enabled: pluginIds, coreTools: customTools, providerName: providerPlugin, permissionGrants: pluginPermissionGrants });
  const bindOwner = tool => ({ ...tool, execute: (toolCallId, args, signal, update, context) => tool.execute(toolCallId, args, signal, update, { ...context, resourceOwnerId }) });
  try {
    let base;
    if (core === "pi") { const { createPiAgentSession } = await import("./pi-agent-session.mjs"); base = await createPiAgentSession({ ...options, customTools: [...customTools, ...plugins.tools].map(bindOwner) }); }
    else {
      const registry = new NativeToolRegistry().registerAll([...customTools, ...plugins.tools].map(bindOwner));
      base = await createNativeAgentSession({ ...options, ...(plugins.provider ? { provider: plugins.provider } : {}), registry });
    }
    const session = withRunLifecycle(base);
    return assertAgentSession({
      ...session,
      pluginContributions: type => plugins.host ? plugins.host.contributions(type) : new Map(),
      dispose: async () => {
        const errors = [];
        for (const dispose of [() => session.dispose(), () => cleanupBrowserSessions(resourceOwnerId), () => plugins.dispose()]) try { await dispose(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "Sandora session disposal was incomplete");
      },
    });
  } catch (error) {
    await plugins.dispose();
    throw error;
  }
}
