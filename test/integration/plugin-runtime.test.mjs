import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandoraSession } from "../../src/runtime/create-session.mjs";

async function pluginFixture(root) {
  const directory = join(root, ".sandora", "plugins", "fixture");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "sandora.plugin.json"), JSON.stringify({ id: "fixture", name: "Fixture", version: "1.0.0", api: 1, entry: "index.mjs", contributes: { tools: ["plugin_echo"], providers: ["fixture"] } }));
  await writeFile(join(directory, "index.mjs"), `
    export function activate(api) {
      api.registerTool("plugin_echo", {
        label: "Plugin echo",
        description: "Echo fixture text",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        execute: async (_id, params) => ({ content: [{ type: "text", text: "PLUGIN:" + params.text }] }),
      });
      api.registerProvider("fixture", {
        model: "plugin-fixture",
        dispose: async () => { globalThis.__sandoraProviderDisposed = (globalThis.__sandoraProviderDisposed || 0) + 1; },
        async *stream({ messages }) {
          if (!messages.some(message => message.role === "tool")) {
            yield { type: "tool_call_delta", index: 0, id: "plugin-call", name: "plugin_echo", arguments: '{"text":"OK"}' };
          } else yield { type: "text_delta", delta: "PLUGIN_PROVIDER_OK" };
        },
      });
      return () => { globalThis.__sandoraPluginDisposed = (globalThis.__sandoraPluginDisposed || 0) + 1; };
    }
  `);
}

test("enabled plugin tools and provider execute through a real native session and dispose with it", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugin-runtime-"));
  try {
    await pluginFixture(root);
    const session = await createSandoraSession({ core: "native", cwd: root, pluginIds: ["fixture"], providerPlugin: "fixture", sessionPath: join(root, ".sandora", "fixture-session.jsonl") });
    const events = [];
    session.subscribe(event => events.push(event));
    await session.prompt("use the plugin");
    assert.equal(session.getLastAssistantText(), "PLUGIN_PROVIDER_OK");
    assert.ok(events.some(event => event.type === "tool.start" && event.name === "plugin_echo"));
    assert.deepEqual(events.filter(event => event.type.startsWith("run.")).map(event => event.type), ["run.start", "run.complete"]);
    await session.dispose();
    assert.equal(globalThis.__sandoraPluginDisposed, 1);
    assert.equal(globalThis.__sandoraProviderDisposed, 1);
  } finally { delete globalThis.__sandoraPluginDisposed; delete globalThis.__sandoraProviderDisposed; await rm(root, { recursive: true, force: true }); }
});

test("plugin configuration fails closed on unavailable plugins and Pi provider injection", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandora-plugin-policy-"));
  try {
    await assert.rejects(() => createSandoraSession({ core: "native", cwd: root, pluginIds: ["missing"] }), /failed to activate/);
    await assert.rejects(() => createSandoraSession({ core: "pi", cwd: root, pluginIds: ["fixture"], providerPlugin: "fixture" }), /native runtime only/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
