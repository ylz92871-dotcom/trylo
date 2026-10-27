import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveContextCeiling } from "./run-context-ceiling.js";
import { resolverForBudget } from "../../adapters/provider/resolver.js";
import { parseArgs } from "./args.js";
import { validateSettingsObject } from "../../settings/schema.js";

test("an undeclared window defaults to the 200K working budget", () => {
  assert.equal(effectiveContextCeiling(undefined, undefined), 200_000);
});

test("the default working budget is capped by declared model capacity", () => {
  assert.equal(effectiveContextCeiling(undefined, 64_000), 64_000);
  assert.equal(effectiveContextCeiling(undefined, 1_000_000), 200_000);
  assert.equal(effectiveContextCeiling(400_000, 128_000), 128_000);
  assert.equal(effectiveContextCeiling(16_384, 1_000_000), 16_384);
});

test("run flags accept independent working and declared model windows", () => {
  const parsed = parseArgs(["run", "--context-window", "200000", "--model-context-window", "128000", "hello"]);
  assert.equal(parsed.kind, "run");
  if (parsed.kind === "run") {
    assert.deepEqual({ ...parsed.options, message: [] }, { readStdin: false, contextTokenLimit: 200_000, modelContextWindow: 128_000, message: [] });
  }
});

test("window flags reject unsafe integers instead of silently losing precision", () => {
  for (const flag of ["--context-window", "--model-context-window"]) {
    for (const value of ["0", "-1", "1.5", "Infinity", "9007199254740993"]) assert.equal(parseArgs(["run", flag, value, "hello"]).kind, "error");
  }
});

test("persisted context sizes reject unsafe values at the settings boundary", () => {
  for (const key of ["contextTokenLimit", "modelContextWindow"]) {
    assert.equal(validateSettingsObject({ [key]: 128_000 }, "user").ok, true);
    for (const value of [0, -1, 1.5, 9007199254740992]) {
      assert.equal(validateSettingsObject({ [key]: value }, "user").ok, false);
    }
  }
});

test("provider budget diagnostics use the same 200K default and capacity cap as execution", () => {
  const provider = { providerId: "test", kind: "openai-compatible" as const, model: "m", endpoint: "https://example.invalid", builtin: false,
    capabilities: { streaming: true, reasoning: false, tools: true, cancellation: true, auth: "none" as const, endpoint: "https://example.invalid", models: [] } };
  assert.equal(resolverForBudget(provider, undefined).effective, 200_000);
  assert.equal(resolverForBudget({ ...provider, contextWindow: 128_000 }, 400_000).effective, 128_000);
});
