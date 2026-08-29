import { mkdir, readFile, rename, writeFile, open, unlink, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { createEvent, EVENT_TYPES, isCanonicalEvent, normalizeEvent, sanitizeEventPayload, validateEvent } from "@sandora/protocol";

export class JsonlSessionStore {
  #sequence;
  #tail = Promise.resolve();
  #ids = new Set();
  #streamId;
  constructor(filePath, { streamId } = {}) { this.filePath = resolve(filePath); this.#streamId = streamId || `stream-${Buffer.from(this.filePath).toString("base64url").slice(0, 40)}`; this.lastRecovery = null; }
  async #lock() {
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + 2_000;
    while (true) {
      try { return await open(lockPath, "wx"); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        let age;
        try { age = Date.now() - (await stat(lockPath)).mtimeMs; } catch { age = 0; }
        if (age > 30_000) throw new Error("stale session append lock; refusing to break it");
        if (Date.now() >= deadline) throw new Error("session append lock is busy; refusing concurrent write");
        await new Promise(resolveSleep => setTimeout(resolveSleep, 10));
      }
    }
  }
  async #repairCrashTail() {
    let bytes;
    try { bytes = await readFile(this.filePath); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!bytes.length || bytes.at(-1) === 0x0a) return;
    const lastNewline = bytes.lastIndexOf(0x0a);
    const tail = bytes.subarray(lastNewline + 1);
    let complete = false;
    try { JSON.parse(tail.toString("utf8")); complete = true; } catch { /* preserve malformed crash tail separately */ }
    const replacement = complete ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes.subarray(0, lastNewline + 1);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.repair.tmp`;
    let quarantinePath = null;
    if (!complete) {
      quarantinePath = `${this.filePath}.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID()}.crash-tail`;
      await writeFile(quarantinePath, tail, { flag: "wx" });
    }
    await writeFile(temporary, replacement, { flag: "wx" });
    await rename(temporary, this.filePath);
    this.lastRecovery = { type: complete ? "terminated-complete-tail" : "quarantined-malformed-tail", bytes: tail.length, quarantinePath };
  }
  async append(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event must be an object");
    const pending = this.#tail.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const lock = await this.#lock();
      try {
        await this.#repairCrashTail();
        const existing = await this.replay();
        this.#sequence = existing.reduce((max, item) => Math.max(max, item.sequence), 0);
        this.#ids = new Set(existing.map(item => item.id));
        const nextSequence = this.#sequence + 1;
        if (isCanonicalEvent(event)) { validateEvent(event, { expectedStreamId: this.#streamId, previousSequence: this.#sequence, ids: this.#ids }); if (event.sequence !== nextSequence) throw new Error("canonical event sequence does not match next stream sequence"); }
        const rawPayload = event.payload ?? Object.fromEntries(Object.entries(event).filter(([key]) => !["protocol", "schema", "schemaVersion", "id", "streamId", "sequence", "timestamp", "actor", "payload", "type", "correlationId", "causationId"].includes(key)));
        const normalized = EVENT_TYPES.has(event.type)
          ? { type: event.type, payload: sanitizeEventPayload(event.type, rawPayload) }
          : normalizeEvent({ ...event, payload: rawPayload, sequence: nextSequence }, { streamId: this.#streamId, sequence: nextSequence, index: nextSequence - 1 });
        const envelope = createEvent(normalized.type, normalized.payload, { id: event.id || randomUUID(), streamId: this.#streamId, sequence: nextSequence, actor: event.actor && typeof event.actor === "object" ? event.actor : { kind: "runtime", id: "sandora-native" }, timestamp: event.timestamp || new Date().toISOString(), correlationId: event.correlationId || rawPayload.turnId, causationId: event.causationId });
        validateEvent(envelope, { expectedStreamId: this.#streamId, previousSequence: this.#sequence, ids: this.#ids });
        const output = await open(this.filePath, "a");
        try { await output.writeFile(`${JSON.stringify(envelope)}\n`, "utf8"); await output.sync(); }
        finally { await output.close(); }
        this.#sequence = nextSequence; this.#ids.add(envelope.id); return envelope;
      } finally { await lock.close(); await unlink(`${this.filePath}.lock`).catch(() => {}); }
    });
    this.#tail = pending.catch(() => {});
    return pending;
  }
  async replay() {
    let text;
    try { text = await readFile(this.filePath, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const terminated = /\r?\n$/.test(text);
    const lines = text.split(/\r?\n/).filter(Boolean);
    const events = [];
    const ids = new Set();
    let previousSequence = 0;
    let replayStreamId;
    for (const [index, line] of lines.entries()) {
      try {
        const event = normalizeEvent(JSON.parse(line), { streamId: this.#streamId, sequence: index + 1, index });
        validateEvent(event, { previousSequence, ids });
        replayStreamId ??= event.streamId;
        if (event.streamId !== replayStreamId || event.streamId !== this.#streamId) throw new Error("session event stream isolation violation");
        previousSequence = event.sequence;
        ids.add(event.id);
        events.push(event);
      } catch (error) {
        if (!terminated && index === lines.length - 1 && error instanceof SyntaxError) return events;
        if (error instanceof SyntaxError) throw new Error(`Invalid JSONL at line ${index + 1}`);
        throw error;
      }
    }
    return events;
  }
  async resume() { return (await this.replay()).filter(event => ["user.message.accepted", "assistant.message.completed", "tool.result.recorded"].includes(event.type)).map(event => event.payload.message).filter(Boolean); }
  async appendMessage(message) { await this.append({ type: "message", message }); }
}
