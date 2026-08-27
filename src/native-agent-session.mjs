import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EventBus, JsonlSessionStore, OpenAICompatibleProvider, runTurn } from "./runtime.mjs";
import { NativeToolRegistry, openAiTools, toolText } from "./tool-registry.mjs";
import { createDelegateSubagentsTool } from "./subagents.mjs";
import { assertAgentSession } from "./agent-session.mjs";

class OfflineProvider {
  constructor(model = "offline") { this.model = model; }
  async *stream() {
    yield { type: "text_delta", delta: "Offline mode: configure OPENAI_MODEL and OPENAI_BASE_URL (plus OPENAI_API_KEY when required) to connect a provider." };
    yield { type: "finish", reason: "stop" };
  }
}

export function providerFromEnvironment(env = process.env, fetchImpl = globalThis.fetch) {
  const configured = Boolean(env.OPENAI_MODEL || env.OPENAI_BASE_URL || env.OPENAI_API_KEY);
  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  if (env.SANDORA_OFFLINE === "1" || !configured) return new OfflineProvider("offline");
  return new OpenAICompatibleProvider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1", model, fetchImpl });
}

export async function createAgentSession({
  cwd = process.cwd(),
  sessionPath = join(cwd, ".sandora", "session.jsonl"),
  provider = providerFromEnvironment(),
  registry = new NativeToolRegistry(),
  systemPrompt = "You are Sandora Agent.",
} = {}) {
  const store = new JsonlSessionStore(sessionPath);
  const bus = new EventBus();
  const resumed = await store.resume();
  const messages = [{ role: "system", content: systemPrompt }, ...resumed.filter(message => message?.role !== "system")];
  if (!registry.has("delegate_subagents")) registry.register(createDelegateSubagentsTool({ provider, cwd }));
  let active;
  const session = {
    sessionId: randomUUID(),
    thinkingLevel: undefined,
    model: { id: provider.model || "custom" },
    getContextUsage: () => ({ tokens: Math.ceil(JSON.stringify(messages).length / 4) }),
    subscribe(listener) {
      const unsubs = [
        bus.on("agent", listener),
        bus.on("text_delta", event => listener({ type: "text.delta", delta: event.delta })),
        bus.on("tool_start", event => listener({ type: "tool.start", name: event.name })),
        bus.on("tool_end", event => listener({ type: "tool.end", name: event.name })),
      ];
      return () => unsubs.forEach(unsubscribe => unsubscribe());
    },
    async prompt(text) {
      if (active) throw new Error("A prompt is already running");
      if (typeof text !== "string" || !text.trim()) throw new TypeError("Prompt text is required");
      const controller = new AbortController();
      active = controller;
      const userMessage = { role: "user", content: text };
      await store.appendMessage(userMessage);
      messages.push(userMessage);
      bus.emit("agent", { type: "agent.start" });
      bus.emit("agent", { type: "message.start", role: "assistant" });
      try {
        const beforeRun = messages.length;
        const result = await runTurn({
          provider,
          messages,
          tools: openAiTools(registry),
          signal: controller.signal,
          bus,
          executeTool: async (name, args, context) => {
            bus.emit("tool_start", { name });
            try { return toolText(await registry.execute(name, args, { ...context, cwd })); }
            finally { bus.emit("tool_end", { name }); }
          },
        });
        for (const message of result.messages.slice(beforeRun)) await store.appendMessage(message);
        bus.emit("agent", { type: "message.end", role: "assistant" });
        return result;
      } finally {
        active = undefined;
      }
    },
    async abort() { active?.abort(new Error("Operation aborted")); },
    dispose() { active?.abort(new Error("Session disposed")); bus.clear(); },
  };
  return assertAgentSession(session);
}
