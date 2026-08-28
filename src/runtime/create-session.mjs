import { createAgentSession as createNativeAgentSession } from "./native-agent-session.mjs";
import { createPiAgentSession } from "./pi-agent-session.mjs";
import { NativeToolRegistry } from "../tools/registry.mjs";

export const DEFAULT_AGENT_CORE = "pi";

export async function createSandoraSession({ core = process.env.SANDORA_AGENT_CORE || DEFAULT_AGENT_CORE, customTools = [], ...options } = {}) {
  if (core === "pi") return createPiAgentSession({ ...options, customTools });
  if (core === "native") {
    const registry = new NativeToolRegistry().registerAll(customTools);
    return createNativeAgentSession({ ...options, registry });
  }
  throw new Error(`Unsupported SANDORA_AGENT_CORE: ${core}. Expected pi or native.`);
}
