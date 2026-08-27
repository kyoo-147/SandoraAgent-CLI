import { createCodingTools } from "./coding-tools.mjs";

// Delegated workers intentionally receive observation-only tools. The same
// registry and path policy used by the parent prevents policy drift.
export default function workerTools(pi) {
  const tools = createCodingTools();
  for (const name of ["workspace_read", "workspace_search", "workspace_list"]) {
    pi.registerTool(tools.find((tool) => tool.name === name));
  }
}
