import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebTools } from "./index.js";

test("a stale web_search call without a mounted search backend is a known unexecuted error", async () => {
  const tools = createWebTools();
  assert.equal(tools.snapshot().some(binding => binding.name === "web_search"), false);
  const outcome = await tools.execute({ toolCallId: "stale-search", name: "web_search", arguments: { query: "example" } }, new AbortController().signal);

  assert.equal(outcome.outcome, "error");
  if (outcome.outcome === "error") assert.equal(outcome.code, "unknown_tool");
});
