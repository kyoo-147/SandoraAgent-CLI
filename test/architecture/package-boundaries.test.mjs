import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const owners = ["packages/protocol", "packages/agent-core", "packages/model-runtime", "packages/session-store", "packages/agent-runtime", "apps/headless"];
const allowed = new Map([
  ["@sandora/protocol", new Set()],
  ["@sandora/agent-core", new Set(["@sandora/protocol"])],
  ["@sandora/model-runtime", new Set()],
  ["@sandora/session-store", new Set(["@sandora/protocol"])],
  ["@sandora/agent-runtime", new Set(["@sandora/agent-core", "@sandora/model-runtime", "@sandora/session-store"])],
  ["@sandora/headless", new Set(["@sandora/protocol", "@sandora/agent-runtime", "@sandora/agent-core"])],
]);

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) files.push(path);
  }
  return files;
}

function importsOf(source) {
  return [...source.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/g)].map(match => match[2]);
}

test("workspace packages expose one public root and obey dependency boundaries", async () => {
  for (const owner of owners) {
    const directory = join(root, owner);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    assert.equal(manifest.private, true, `${owner} must remain private during migration`);
    assert.equal(manifest.type, "module");
    assert.equal(manifest.engines?.node, ">=22.19.0");
    assert.deepEqual(Object.keys(manifest.exports), ["."], `${owner} must not expose deep imports`);
    const declared = new Set(Object.keys(manifest.dependencies || {}).filter(name => name.startsWith("@sandora/")));
    for (const dependency of declared) assert.ok(allowed.get(manifest.name)?.has(dependency), `${manifest.name} cannot depend on ${dependency}`);
    for (const file of await sourceFiles(join(directory, "src"))) {
      const source = await readFile(file, "utf8");
      assert.doesNotMatch(source, /@earendil-works\/pi/, `${relative(root, file)} imports Pi`);
      for (const specifier of importsOf(source).filter(value => value.startsWith("@sandora/"))) {
        assert.match(specifier, /^@sandora\/[a-z][a-z-]*$/, `${relative(root, file)} uses a deep Sandora import`);
        assert.ok(allowed.get(manifest.name)?.has(specifier), `${manifest.name} cannot import ${specifier}`);
        assert.ok(declared.has(specifier), `${manifest.name} must declare ${specifier}`);
      }
      for (const specifier of importsOf(source).filter(value => value.startsWith("."))) {
        const relation = relative(directory, resolve(dirname(file), specifier));
        assert.ok(relation && !relation.startsWith("..") && !isAbsolute(relation), `${relative(root, file)} escapes its package with ${specifier}`);
      }
      if (manifest.name === "@sandora/protocol") assert.doesNotMatch(source, /node:(?:fs|child_process|http|https|net|tls|worker_threads)/, "protocol must not perform I/O");
    }
  }
});

test("compatibility modules preserve public contract identity", async () => {
  const protocol = await import("@sandora/protocol");
  const legacyEvents = await import("../../src/runtime/events.mjs");
  const core = await import("@sandora/agent-core");
  const legacySession = await import("../../src/runtime/agent-session.mjs");
  const runtime = await import("@sandora/agent-runtime");
  const legacyTurn = await import("../../src/runtime/turn-runtime.mjs");
  const headless = await import("@sandora/headless");
  const legacyHeadless = await import("../../src/cli/headless-jsonl.mjs");
  assert.equal(legacyEvents.createEvent, protocol.createEvent);
  assert.equal(legacySession.assertAgentSession, core.assertAgentSession);
  assert.equal(legacyTurn.runTurn, runtime.runTurn);
  assert.equal(legacyTurn.JsonlSessionStore, runtime.JsonlSessionStore);
  assert.equal(legacyTurn.OpenAICompatibleProvider, runtime.OpenAICompatibleProvider);
  assert.equal(legacyHeadless.JSONL_PROTOCOL, headless.JSONL_PROTOCOL);
  assert.equal(legacyHeadless.JSONL_VERSION, headless.JSONL_VERSION);
});
