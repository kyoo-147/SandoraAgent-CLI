import { createAgentSession as createNativeAgentSession } from "./native-agent-session.mjs";
import { createPiAgentSession } from "./pi-agent-session.mjs";
import { NativeToolRegistry } from "../tools/registry.mjs";
import { assertAgentSession, withRunLifecycle } from "./agent-session.mjs";
import { configuredPluginIds, loadSessionPlugins } from "../plugins/runtime.mjs";

export const DEFAULT_AGENT_CORE = "pi";

export async function createSandoraSession({
  core = process.env.SANDORA_AGENT_CORE || DEFAULT_AGENT_CORE,
  customTools = [],
  pluginIds = configuredPluginIds(),
  providerPlugin = process.env.SANDORA_PROVIDER_PLUGIN,
  ...options
} = {}) {
  if (!['pi', 'native'].includes(core)) throw new Error(`Unsupported SANDORA_AGENT_CORE: ${core}. Expected pi or native.`);
  if (core === "pi" && providerPlugin) throw new Error("Plugin providers are supported by the native runtime only; Pi providers must be configured through Pi ModelRuntime");
  const plugins = await loadSessionPlugins({ cwd: options.cwd || process.cwd(), enabled: pluginIds, coreTools: customTools, providerName: providerPlugin });
  try {
    let base;
    if (core === "pi") base = await createPiAgentSession({ ...options, customTools: [...customTools, ...plugins.tools] });
    else {
      const registry = new NativeToolRegistry().registerAll([...customTools, ...plugins.tools]);
      base = await createNativeAgentSession({ ...options, ...(plugins.provider ? { provider: plugins.provider } : {}), registry });
    }
    const session = withRunLifecycle(base);
    if (!plugins.host) return session;
    return assertAgentSession({
      ...session,
      dispose: async () => {
        try { await session.dispose(); }
        finally { await plugins.dispose(); }
      },
    });
  } catch (error) {
    await plugins.dispose();
    throw error;
  }
}
