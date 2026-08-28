import { createCodingTools } from "../tools/coding-tools.mjs";

export const READ_ONLY_WORKER_TOOL_NAMES = ["workspace_read", "workspace_search", "workspace_list"];

/** Register the bounded observation-only tool surface used by native workers. */
export default function workerTools(registry) {
  const tools = createCodingTools();
  const register = registry.register?.bind(registry) || registry.registerTool?.bind(registry);
  if (!register) throw new TypeError("Worker tool registry must expose register(tool)");
  for (const name of READ_ONLY_WORKER_TOOL_NAMES) register(tools.find(tool => tool.name === name));
  return registry;
}
