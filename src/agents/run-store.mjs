import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const VERSION = 1;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validateId(value) {
  if (typeof value !== "string" || !idPattern.test(value)) throw new Error("Invalid run id");
  return value;
}

async function appendDurable(path, value) {
  const handle = await open(path, "a", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

/** Local crash-durable scheduler manifest and event log. This is not a distributed scheduler. */
export class FileTaskRunStore {
  constructor({ root } = {}) { if (!root) throw new Error("run store root is required"); this.root = resolve(root); }
  path(runId) { return resolve(this.root, `${validateId(runId)}.jsonl`); }
  async create({ runId, identity, tasks }) {
    const path = this.path(runId); await mkdir(this.root, { recursive: true });
    const manifest = { version: VERSION, type: "manifest", runId, identity, tasks: tasks.map(task => ({ ...task, result: undefined, error: undefined, artifacts: [] })) };
    try { const handle = await open(path, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); } }
    catch (error) { if (error.code !== "EEXIST") throw error; const existing = await this.read(runId); if (existing.identity !== identity) throw new Error(`run ID collision: ${runId}`); }
  }
  async event(runId, event) { await appendDurable(this.path(runId), { version: VERSION, type: "event", ...event }); }
  async read(runId) {
    let lines;
    try { lines = (await readFile(this.path(runId), "utf8")).split("\n").filter(Boolean); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    let manifest; const events = [];
    for (const line of lines) { let item; try { item = JSON.parse(line); } catch { throw new Error("RECONCILE_REQUIRED: malformed run store"); } if (item.type === "manifest" && !manifest) manifest = item; else if (item.type === "event") events.push(item); else throw new Error("RECONCILE_REQUIRED: invalid run store record"); }
    if (!manifest || manifest.version !== VERSION || manifest.runId !== runId || !Array.isArray(manifest.tasks)) throw new Error("RECONCILE_REQUIRED: invalid run manifest");
    const tasks = new Map(manifest.tasks.map(task => [task.agentId, { ...task }]));
    for (const event of events) { const task = tasks.get(event.agentId); if (!task) throw new Error("RECONCILE_REQUIRED: event references unknown task"); Object.assign(task, event.patch); }
    return { ...manifest, tasks: [...tasks.values()], events };
  }
}
