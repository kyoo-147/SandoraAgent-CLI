import { createHash, randomUUID } from "node:crypto";

export const EVENT_PROTOCOL = "sandora.event/v1";
export const EVENT_SCHEMA_VERSION = 1;
export const EVENT_TYPES = new Set([
  "session.created", "session.resumed", "session.closed", "turn.requested", "turn.started", "turn.completed", "turn.failed", "turn.cancel.requested", "turn.cancelled",
  "user.message.accepted", "model.request.requested", "model.request.started", "model.request.completed", "model.request.failed", "model.request.unknown", "model.usage",
  "assistant.message.started", "assistant.delta", "assistant.message.completed", "assistant.message.interrupted", "context.compacted",
  "tool.call.requested", "tool.call.started", "tool.call.completed", "tool.call.failed", "tool.call.cancelled", "tool.call.unknown", "tool.result.recorded",
  "recovery.tool_result_synthesized", "runtime.unknown",
]);
const MAX_STRING_BYTES = 20_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const SECRET_KEY = /(?:secret|token|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key|cookie|set-cookie|headers?|signature|\bsig\b|\bauth\b)/i;
const LEGACY_TYPES = new Map([
  ["session.started", "session.created"], ["session.resumed", "session.resumed"], ["turn.started", "turn.started"], ["turn.completed", "turn.completed"],
  ["turn.failed", "turn.failed"], ["turn.aborted", "turn.cancelled"], ["turn.cancel.requested", "turn.cancel.requested"], ["model.started", "model.request.started"],
  ["tool.started", "tool.call.started"], ["tool.completed", "tool.call.completed"], ["tool.failed", "tool.call.failed"],
  ["assistant.partial", "assistant.message.interrupted"], ["recovery.tool_result_synthesized", "recovery.tool_result_synthesized"],
]);

export function isCanonicalEvent(value) { return value && typeof value === "object" && value.protocol === EVENT_PROTOCOL && value.schemaVersion === EVENT_SCHEMA_VERSION; }

function validActor(actor) { return actor && typeof actor === "object" && !Array.isArray(actor) && typeof actor.kind === "string" && actor.kind && typeof actor.id === "string" && actor.id; }
export function validateEvent(event, { expectedStreamId, previousSequence, ids } = {}) {
  if (!isCanonicalEvent(event)) throw new TypeError("event protocol/schemaVersion must be sandora.event/v1 and 1");
  for (const field of ["id", "streamId", "type", "timestamp"]) if (typeof event[field] !== "string" || !event[field].trim()) throw new TypeError(`event ${field} is required`);
  if (!EVENT_TYPES.has(event.type)) throw new TypeError(`unsupported canonical event type: ${event.type}`);
  if (!validActor(event.actor)) throw new TypeError("event actor must contain kind and id");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new TypeError("event sequence must be a positive integer");
  if (expectedStreamId && event.streamId !== expectedStreamId) throw new Error("event streamId does not match session stream");
  if (Number.isSafeInteger(previousSequence) && event.sequence <= previousSequence) throw new Error("event sequence must strictly increase");
  if (ids?.has(event.id)) throw new Error(`duplicate event id: ${event.id}`);
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new TypeError("event payload must be an object");
  const allowed = new Set(["protocol", "schemaVersion", "id", "streamId", "sequence", "timestamp", "type", "actor", "payload", "correlationId", "causationId"]);
  for (const key of Object.keys(event)) if (!allowed.has(key)) throw new TypeError(`unexpected canonical envelope field: ${key}`);
  return event;
}

function redactText(value) {
  let text = String(value);
  text = text.replace(/([?&](?:token|api[_-]?key|secret|password|authorization|credential|auth|sig|signature)=)[^&#\s]+/gi, "$1[REDACTED]");
  text = text.replace(/((?:authorization|cookie|set-cookie)\s*:\s*)(?:bearer\s+)?[^\r\n,;]+/gi, "$1[REDACTED]");
  text = text.replace(/(["'](?:secret|token|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key|cookie)["']\s*:\s*)["'][^"']*["']/gi, "$1\"[REDACTED]\"");
  text = text.replace(/((?:secret|token|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key|cookie)\s*[=:]\s*)(["']?)[^\s,;}"']+\2/gi, "$1[REDACTED]");
  return text;
}
function truncateUtf8(value, maxBytes) { const buffer = Buffer.from(value); return buffer.length <= maxBytes ? value : `${buffer.subarray(0, Math.max(0, maxBytes - 16)).toString("utf8")}…[truncated]`; }
function sanitize(value, key = "", depth = 0) {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return truncateUtf8(redactText(value), MAX_STRING_BYTES);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, "", depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 200).map(([name, item]) => [name, sanitize(item, name, depth + 1)]));
  return truncateUtf8(redactText(String(value)), MAX_STRING_BYTES);
}
export function sanitizeEventPayload(type, payload) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { value: payload };
  const result = sanitize(source);
  if (/^tool\.call\./.test(type)) for (const key of ["args", "arguments", "input", "output", "result", "rawOutput", "rawResult"]) delete result[key];
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PAYLOAD_BYTES) throw new Error(`event payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  return result;
}

function legacyType(event) {
  if (event.type === "message") return event.message?.role === "user" ? "user.message.accepted" : event.message?.role === "assistant" ? "assistant.message.completed" : "tool.result.recorded";
  return LEGACY_TYPES.get(event.type) || "runtime.unknown";
}
function legacyPayload(event) {
  const payload = { ...event };
  for (const key of ["protocol", "schema", "schemaVersion", "id", "streamId", "sequence", "timestamp", "actor", "payload", "type"]) delete payload[key];
  return Object.keys(payload).length ? payload : (event.payload ?? {});
}
export function normalizeEvent(event, { streamId = "legacy", sequence = 1, index = 0 } = {}) {
  if (isCanonicalEvent(event)) return validateEvent(event);
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event must be an object");
  const payload = sanitizeEventPayload(legacyType(event), legacyPayload(event));
  return createEvent(legacyType(event), payload, {
    id: `legacy-${createHash("sha256").update(JSON.stringify(event)).update(`:${index}`).digest("hex").slice(0, 32)}`,
    streamId,
    sequence: Number.isSafeInteger(event.sequence) && event.sequence > 0 ? event.sequence : sequence,
    timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date(0).toISOString(),
    actor: { kind: "runtime", id: "legacy" },
  });
}
export function createEvent(type, payload = {}, { id = randomUUID(), streamId, sequence, actor = { kind: "runtime", id: "sandora-native" }, timestamp = new Date().toISOString(), correlationId, causationId } = {}) {
  const event = { protocol: EVENT_PROTOCOL, schemaVersion: EVENT_SCHEMA_VERSION, id, streamId, sequence, timestamp, type, actor, payload: sanitizeEventPayload(type, payload), ...(correlationId ? { correlationId } : {}), ...(causationId ? { causationId } : {}) };
  return validateEvent(event);
}
export function boundedAuditValue(value, maxBytes = 4096) { const text = typeof value === "string" ? value : JSON.stringify(value); return text ? truncateUtf8(redactText(text), maxBytes) : ""; }
