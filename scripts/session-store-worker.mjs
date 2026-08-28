import { JsonlSessionStore } from "../src/runtime/turn-runtime.mjs";

const [path, streamId, prefix, rawCount] = process.argv.slice(2);
if (!path || !streamId || !prefix) process.exit(2);
const store = new JsonlSessionStore(path, { streamId });
for (let index = 0; index < Number(rawCount || 1); index += 1) {
  await store.append({ type: "runtime.unknown", worker: prefix, index });
  await new Promise(resolve => setTimeout(resolve, index % 3));
}
