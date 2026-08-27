import test from "node:test";
import assert from "node:assert/strict";
import { browserTools } from "../src/browser-tools.mjs";

test("browser and computer contracts are registered", () => {
  const names = browserTools.map(tool => tool.name);
  assert.deepEqual(names, [
    "browser_launch", "browser_connect", "browser_observe", "browser_navigate",
    "browser_click", "browser_type", "browser_scroll", "browser_tabs",
    "browser_screenshot", "browser_cleanup", "computer_observe", "computer_focus",
    "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_screenshot",
  ]);
});

test("computer tools fail closed with an explicit capability response", async () => {
  const tool = browserTools.find(candidate => candidate.name === "computer_observe");
  const result = await tool.execute("test", {});
  assert.equal(result.details.supported, false);
  assert.match(result.content[0].text, /supported/);
});
