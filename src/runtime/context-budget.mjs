import { createHash } from "node:crypto";

export const CONTEXT_COMPACTION_ALGORITHM = "native-context/v1";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function stableJson(value) { return JSON.stringify(canonical(value)); }
export function measureContext(messages, { tokenNumerator = 1, tokenDenominator = 4 } = {}) {
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array");
  if (!Number.isSafeInteger(tokenNumerator) || tokenNumerator <= 0 || !Number.isSafeInteger(tokenDenominator) || tokenDenominator <= 0) throw new TypeError("token estimate ratio must use positive integers");
  const bytes = Buffer.byteLength(stableJson(messages), "utf8");
  const estimatedTokens = Math.ceil(bytes * tokenNumerator / tokenDenominator);
  return { bytes, tokens: estimatedTokens, estimatedTokens, tokenEstimateConfidence: "ESTIMATE" };
}
function idOf(message, index) { return message?.messageId || message?.id || `message-${index}`; }
export function groupMessages(messages) {
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array");
  const groups = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (!message || typeof message !== "object" || typeof message.role !== "string") throw new TypeError("invalid context message");
    if (message.role === "system") { groups.push({ messages: [message], ids: [idOf(message, index)], pinned: true }); index++; continue; }
    if (message.role === "tool") throw new Error("CONTEXT_ORPHAN_TOOL_MESSAGE");
    const start = index; const block = [];
    while (index < messages.length && messages[index]?.role !== "system" && (index === start || messages[index]?.role !== "user")) {
      const current = messages[index];
      if (!current || typeof current !== "object" || typeof current.role !== "string") throw new TypeError("invalid context message");
      if (current.role === "tool") throw new Error("CONTEXT_ORPHAN_TOOL_MESSAGE");
      block.push(current); index++;
      if (current.role === "assistant" && Array.isArray(current.tool_calls) && current.tool_calls.length) {
        const calls = new Set();
        for (const call of current.tool_calls) { if (!call?.id || calls.has(call.id)) throw new Error("CONTEXT_DUPLICATE_TOOL_CALL_ID"); calls.add(call.id); }
        const results = new Set();
        while (index < messages.length && messages[index]?.role === "tool") { const result = messages[index++]; if (!calls.has(result.tool_call_id)) throw new Error("CONTEXT_MISMATCHED_TOOL_RESULT"); if (results.has(result.tool_call_id)) throw new Error("CONTEXT_DUPLICATE_TOOL_RESULT"); results.add(result.tool_call_id); block.push(result); }
        if (results.size !== calls.size) throw new Error("CONTEXT_INCOMPLETE_TOOL_GROUP");
      }
    }
    groups.push({ messages: block, ids: block.map((item, offset) => idOf(item, start + offset)), pinned: false });
  }
  return groups;
}
export function selectContextGroups(groups, { maxBytes, reserveBytes = 0 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("maxBytes must be a non-negative integer");
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0 || reserveBytes > maxBytes) throw new TypeError("reserveBytes must be between zero and maxBytes");
  const limit = maxBytes - reserveBytes;
  const pinned = groups.filter(group => group.pinned);
  const newest = groups.filter(group => !group.pinned).reverse();
  const chosen = [...pinned];
  if (measureContext(chosen.map(group => group.messages).flat()).bytes > limit) throw new Error("CONTEXT_GROUP_TOO_LARGE");
  for (const [index, group] of newest.entries()) {
    const candidate = [...pinned, ...chosen.filter(item => !item.pinned), group];
    if (measureContext(candidate.map(item => item.messages).flat()).bytes <= limit) chosen.push(group);
    else if (index === 0) throw new Error("CONTEXT_GROUP_TOO_LARGE");
  }
  return groups.filter(group => chosen.includes(group));
}
export function compactContext(messages, options) {
  const groups = groupMessages(messages);
  const before = measureContext(messages);
  const selected = selectContextGroups(groups, options);
  const retained = selected.flatMap(group => group.messages);
  const after = measureContext(retained);
  const retainedMessageIds = selected.flatMap(group => group.ids); const ids = new Set(retainedMessageIds);
  return { messages: retained, before: { ...before, groups: groups.length, messages: messages.length }, after: { ...after, groups: selected.length, messages: retained.length }, droppedMessageIds: groups.flatMap(group => group.ids).filter(id => !ids.has(id)), retainedMessageIds, algorithm: CONTEXT_COMPACTION_ALGORITHM, contextSha256: createHash("sha256").update(stableJson(retained)).digest("hex") };
}
export function validateCompactionProvenance(provenance, messages) {
  if (!provenance || provenance.algorithm !== CONTEXT_COMPACTION_ALGORITHM) throw new Error("invalid context compaction algorithm");
  const allIds = messages.map((message, index) => idOf(message, index)); const ids = new Set(allIds);
  if (!Array.isArray(provenance.retainedMessageIds) || new Set(provenance.retainedMessageIds).size !== provenance.retainedMessageIds.length || provenance.retainedMessageIds.some(id => !ids.has(id))) throw new Error("invalid context compaction retained IDs");
  if (provenance.sourceMessageCount !== messages.length || provenance.sourceEventRange?.first !== allIds[0] || provenance.sourceEventRange?.last !== allIds.at(-1)) throw new Error("invalid context compaction source range");
  const retained = messages.filter((message, index) => (provenance.retainedMessageIds || []).includes(idOf(message, index)));
  if (provenance.contextSha256 !== createHash("sha256").update(stableJson(retained)).digest("hex")) throw new Error("invalid context compaction hash");
  const before = measureContext(messages); const after = measureContext(retained);
  if (provenance.before?.messages !== messages.length || provenance.before?.bytes !== before.bytes || provenance.after?.messages !== retained.length || provenance.after?.bytes !== after.bytes) throw new Error("invalid context compaction counts");
  return retained;
}
