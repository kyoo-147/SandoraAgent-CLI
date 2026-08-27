import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureProvider, collectStream } from "./fixtures/fake-provider.mjs";

async function recover(provider, prompt, attempts = 2) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await collectStream(provider, prompt);
    if (!result.error) return result;
  }
  throw new Error("session recovery exhausted");
}

test("fixture provider streams tool, text, and completion events", async () => {
  const result = await collectStream(createFixtureProvider(), "hello");
  assert.equal(result.error, null);
  assert.deepEqual(result.events.map((event) => event.type), ["message_start", "tool_start", "tool_end", "text_delta", "message_end"]);
  assert.equal(result.events.find((event) => event.type === "text_delta").delta, "fixture:hello");
});

test("fixture provider exposes errors and session recovery retries once", async () => {
  const provider = createFixtureProvider({ failFirst: true });
  const failed = await collectStream(provider, "recover");
  assert.match(failed.error.message, /unavailable/);
  const recovered = await recover(provider, "recover");
  assert.equal(provider.attempts, 2);
  assert.equal(recovered.error, null);
});

test("recovery fixture persists a resumable session transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandora-qa-"));
  try {
    const transcript = join(directory, "session.jsonl");
    await writeFile(transcript, '{"role":"user","text":"before failure"}\n');
    const provider = createFixtureProvider({ failFirst: true });
    await collectStream(provider, "after restart");
    const recovered = await recover(provider, "after restart");
    await writeFile(transcript, `{"role":"assistant","text":"${recovered.events.find((event) => event.type === "text_delta").delta}"}\n`, { flag: "a" });
    const lines = (await readFile(transcript, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.role), ["user", "assistant"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
