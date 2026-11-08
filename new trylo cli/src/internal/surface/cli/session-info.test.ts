import assert from "node:assert/strict";
import { test } from "node:test";
import {
  modelSwitchOptions,
  statusLines,
  usageLines,
  type SessionFacts,
} from "./session-info.js";

/**
 * `/status` and `/usage`.
 *
 * The load-bearing case is the second one: with no usage record these commands
 * must not print zero. A provider that never reports usage and a turn that
 * cost nothing are different facts, and a CLI that prints `0` for both is how
 * a person concludes a long run was free.
 */

const FACTS: SessionFacts = {
  sessionId: "repl-2f8c1a44",
  providerId: "openai-compatible",
  model: "qwen3-coder-plus",
  maxIterations: 32,
  contextTokenLimit: undefined,
};

test("status names the session, the provider, the model and the budget", () => {
  const said = statusLines(FACTS, 3).join("\n");
  assert.match(said, /repl-2f8c1a44/);
  assert.match(said, /openai-compatible/);
  assert.match(said, /qwen3-coder-plus/);
  assert.match(said, /3 \/ 32/);
});

test("status says nothing was run yet rather than inventing a count", () => {
  const said = statusLines(FACTS, undefined).join("\n");
  assert.match(said, /- \/ 32/);
  assert.equal(said.includes("0 / 32"), false);
});

test("an unreported usage is reported as unreported, not as zero", () => {
  const said = usageLines(undefined, undefined).join("\n");
  assert.match(said, /no usage reported/i);
  assert.equal(/\b0\b/.test(said), false, "printing 0 would claim a cost nobody measured");
});

test("a reported usage is printed as the numbers the provider gave", () => {
  const said = usageLines({ inputTokens: 18422, outputTokens: 913, totalTokens: 19335 }, 41_300).join("\n");
  assert.match(said, /18422/);
  assert.match(said, /913/);
  assert.match(said, /19335/);
  assert.match(said, /41\.3s/);
});

test("a usage without a duration leaves the duration out instead of saying zero", () => {
  const said = usageLines({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }, undefined).join("\n");
  assert.match(said, /total/);
  assert.equal(said.includes("s\n"), false);
});

test("both commands align their labels", () => {
  const status = statusLines(FACTS, 1);
  const usage = usageLines({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }, 1000);

  for (const group of [status, usage]) {
    // Where the value column starts: the label plus the padding after it.
    const at = group.map((line) => (line.match(/^\S+\s+/) ?? [""])[0]?.length ?? 0);
    assert.equal(new Set(at).size, 1, `values start at different columns: ${at.join(",")}`);
  }
});

test("switching model opens a *new* session, because a journal keeps its model", () => {
  const options = modelSwitchOptions("repl-new", "gpt-4o-mini");

  assert.equal(options.model, "gpt-4o-mini");
  assert.equal(options.session, "repl-new");
  // Not `resume`: resuming the current journal under a different model is
  // refused by the store (`model changed`), which is why a switch starts one.
  assert.equal(options.resume, undefined);
  assert.deepEqual(options.message, []);
});

test("a model switch carries the learning switch through", () => {
  assert.equal(modelSwitchOptions("s", "m", "all").learning, "all");
  assert.equal(modelSwitchOptions("s", "m").learning, undefined);
});

test("switching model opens a *new* session, because a journal keeps its model", () => {
  const options = modelSwitchOptions("repl-new", "gpt-4o-mini");

  assert.equal(options.model, "gpt-4o-mini");
  assert.equal(options.session, "repl-new");
  // Not `resume`: resuming the current journal under a different model is
  // refused by the store (`model changed`), which is why a switch starts one.
  assert.equal(options.resume, undefined);
  assert.deepEqual(options.message, []);
});

test("a model switch carries the learning switch through", () => {
  assert.equal(modelSwitchOptions("s", "m", "all").learning, "all");
  assert.equal(modelSwitchOptions("s", "m").learning, undefined);
});
