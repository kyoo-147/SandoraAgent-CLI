export function createFixtureProvider({ failFirst = false } = {}) {
  let attempts = 0;
  return {
    get attempts() { return attempts; },
    async *stream(prompt) {
      attempts += 1;
      if (failFirst && attempts === 1) throw new Error("fixture provider unavailable");
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_start", name: "fixture_echo" };
      yield { type: "tool_end", name: "fixture_echo", output: prompt };
      yield { type: "text_delta", delta: `fixture:${prompt}` };
      yield { type: "message_end" };
    },
  };
}

export async function collectStream(provider, prompt) {
  const events = [];
  try {
    for await (const event of provider.stream(prompt)) events.push(event);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}
