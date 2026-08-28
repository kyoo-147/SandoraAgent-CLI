/** Sandora-owned tool contract and registry. Runtime adapters never depend on a provider SDK. */
export function defineTool(tool) {
  if (!tool?.name || typeof tool.execute !== "function") throw new TypeError("Tool name and execute are required");
  return Object.freeze({ ...tool });
}

export function toolText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value?.content)) {
    const rows = value.content.filter(item => item?.type === "text").map(item => item.text);
    if (rows.length) return rows.join("\n");
  }
  return JSON.stringify(value ?? null);
}

export class NativeToolRegistry {
  #tools = new Map();
  register(tool) {
    const value = defineTool(tool);
    if (this.#tools.has(value.name)) throw new Error(`Tool already registered: ${value.name}`);
    this.#tools.set(value.name, value);
    return value;
  }
  registerAll(tools = []) { for (const tool of tools) this.register(tool); return this; }
  has(name) { return this.#tools.has(name); }
  get(name) { return this.#tools.get(name); }
  list() { return [...this.#tools.values()]; }
  async execute(name, args, { signal, cwd } = {}) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.execute(`native-${Date.now()}`, args || {}, signal, undefined, { cwd });
  }
}

export function openAiTools(registry) {
  return registry.list().map(({ name, description, parameters }) => ({
    type: "function",
    function: { name, description, parameters: parameters || { type: "object", properties: {} } },
  }));
}
