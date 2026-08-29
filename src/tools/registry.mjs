/** Sandora-owned tool contract and registry. Runtime adapters never depend on a provider SDK. */
const SCHEMA_KEYS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "default", "description", "title", "$schema", "minLength", "maxLength", "minimum", "maximum", "pattern", "minItems", "maxItems", "minProperties", "maxProperties"]);
const JSON_SCHEMA_TYPES = new Set(["null", "object", "array", "integer", "number", "string", "boolean"]);
function schemaDefinitionError(message) { throw new TypeError(`Unsupported tool schema: ${message}`); }
function assertSupportedSchema(schema, path = "$") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) schemaDefinitionError(`${path} must be an object`);
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key)) schemaDefinitionError(`${path} uses ${key}`);
  const types = schema.type === undefined ? [] : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (types.some(type => !JSON_SCHEMA_TYPES.has(type))) schemaDefinitionError(`${path} has an unknown type`);
  if (schema.pattern !== undefined) { if (typeof schema.pattern !== "string") schemaDefinitionError(`${path} pattern must be a string`); try { new RegExp(schema.pattern); } catch { schemaDefinitionError(`${path} pattern is invalid`); } }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string"))) schemaDefinitionError(`${path} required is invalid`);
  if (schema.properties !== undefined) { if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) schemaDefinitionError(`${path} properties is invalid`); for (const [key, value] of Object.entries(schema.properties)) assertSupportedSchema(value, `${path}.properties.${key}`); }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) schemaDefinitionError(`${path} only supports additionalProperties:false`);
  if (schema.items !== undefined) assertSupportedSchema(schema.items, `${path}.items`);
  if (types.includes("array") && schema.items === undefined) schemaDefinitionError(`${path} array items are required`);
  if (schema.anyOf !== undefined) { if (!Array.isArray(schema.anyOf) || !schema.anyOf.length) schemaDefinitionError(`${path} anyOf is invalid`); schema.anyOf.forEach((candidate, index) => assertSupportedSchema(candidate, `${path}.anyOf[${index}]`)); }
  return schema;
}

function schemaError(message) { throw new TypeError(`Invalid arguments: ${message}`); }
function checkSchema(schema, value, path = "$") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) schemaError(`${path} has no supported JSON schema`);
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key)) schemaError(`unsupported schema keyword ${key}`);
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || !schema.anyOf.length) schemaError(`${path} anyOf is invalid`);
    const matched = schema.anyOf.some(candidate => { try { checkSchema(candidate, value, path); return true; } catch (error) { if (!(error instanceof TypeError) || !error.message.startsWith("Invalid arguments:")) throw error; return false; } });
    if (!matched) schemaError(`${path} does not match anyOf`);
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) schemaError(`${path} must equal const`);
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value)))) schemaError(`${path} is not in enum`);
  const types = schema.type === undefined ? [] : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (types.length && !types.some(type => type === "null" ? value === null : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : type === "array" ? Array.isArray(value) : type === "integer" ? Number.isInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : type === "string" ? typeof value === "string" : type === "boolean" && typeof value === "boolean")) schemaError(`${path} has invalid type`);
  if (typeof value === "string") { if (schema.minLength !== undefined && value.length < schema.minLength) schemaError(`${path} is too short`); if (schema.maxLength !== undefined && value.length > schema.maxLength) schemaError(`${path} is too long`); if (schema.pattern !== undefined && !(new RegExp(schema.pattern).test(value))) schemaError(`${path} does not match pattern`); }
  if (typeof value === "number") { if (schema.minimum !== undefined && value < schema.minimum) schemaError(`${path} is below minimum`); if (schema.maximum !== undefined && value > schema.maximum) schemaError(`${path} is above maximum`); }
  if (Array.isArray(value)) { if (schema.minItems !== undefined && value.length < schema.minItems) schemaError(`${path} has too few items`); if (schema.maxItems !== undefined && value.length > schema.maxItems) schemaError(`${path} has too many items`); if (!schema.items) schemaError(`${path} array items schema is required`); value.forEach((item, index) => checkSchema(schema.items, item, `${path}[${index}]`)); }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const required = schema.required === undefined ? [] : schema.required;
    if (!Array.isArray(required) || required.some(key => typeof key !== "string")) schemaError(`${path} required is invalid`);
    const properties = schema.properties === undefined ? {} : schema.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) schemaError(`${path} properties is invalid`);
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) schemaError(`${path} has too few properties`);
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) schemaError(`${path} has too many properties`);
    for (const key of required) if (!Object.hasOwn(value, key)) schemaError(`${path}.${key} is required`);
    for (const key of Object.keys(value)) { if (!Object.hasOwn(properties, key)) { if (schema.properties === undefined && schema.additionalProperties !== false) continue; if (schema.additionalProperties !== false) schemaError(`${path}.${key} is not explicitly schema-bound`); schemaError(`${path}.${key} is not allowed`); } checkSchema(properties[key], value[key], `${path}.${key}`); }
  }
}
export function validateToolArgs(tool, args) {
  if (!tool) throw new Error("Unknown tool");
  if (!tool.parameters) return args && typeof args === "object" && !Array.isArray(args) ? args : schemaError("arguments must be an object");
  checkSchema(tool.parameters, args);
  return args;
}

export function defineTool(tool) {
  if (!tool?.name || typeof tool.execute !== "function") throw new TypeError("Tool name and execute are required");
  if (tool.parameters) assertSupportedSchema(tool.parameters);
  return Object.freeze({ ...tool });
}
export function toolText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value?.content)) { const rows = value.content.filter(item => item?.type === "text").map(item => item.text); if (rows.length) return rows.join("\n"); }
  return JSON.stringify(value ?? null);
}
export class NativeToolRegistry {
  #tools = new Map();
  register(tool) { const value = defineTool(tool); if (this.#tools.has(value.name)) throw new Error(`Tool already registered: ${value.name}`); this.#tools.set(value.name, value); return value; }
  registerAll(tools = []) { for (const tool of tools) this.register(tool); return this; }
  has(name) { return this.#tools.has(name); }
  get(name) { return this.#tools.get(name); }
  list() { return [...this.#tools.values()]; }
  async execute(name, args, { signal, cwd, toolCallId } = {}) { const tool = this.get(name); if (!tool) throw new Error(`Unknown tool: ${name}`); const input = args === undefined ? {} : args; validateToolArgs(tool, input); return tool.execute(toolCallId || `native-${Date.now()}`, input, signal, undefined, { cwd }); }
}
export function openAiTools(registry) { return registry.list().map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters: parameters || { type: "object", properties: {} } } })); }
