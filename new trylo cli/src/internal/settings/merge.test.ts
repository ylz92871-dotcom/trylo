import assert from "node:assert/strict";
import test from "node:test";
import { concatStringArrays, mergeValue, resolveSettings, type LayerContribution } from "./merge.js";

/**
 * Merge policy: higher precedence wins on scalars; concat keys append and
 * de-duplicate. The concat mechanism is injected as a predicate, so it is proven
 * here with a synthetic concat key even though the production schema has none —
 * the mechanism stays real without an unreachable branch in the load path.
 */

test("concatStringArrays appends and de-duplicates, preserving first-seen order", () => {
  assert.deepEqual(concatStringArrays(["a", "b"], ["b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(concatStringArrays([], ["x"]), ["x"]);
  assert.deepEqual(concatStringArrays(["x"], []), ["x"]);
  assert.deepEqual(concatStringArrays(["a", "a"], ["a"]), ["a"]);
});

test("mergeValue: a non-concat key takes the override", () => {
  assert.equal(mergeValue("model", "low", "high"), "high");
});

test("mergeValue: a concat key with two string arrays appends", () => {
  const isConcat = (key: string): boolean => key === "list";
  assert.deepEqual(mergeValue("list", ["a"], ["b"], isConcat), ["a", "b"]);
});

test("mergeValue: a concat key whose values are not both string arrays falls back to override", () => {
  const isConcat = (): boolean => true;
  assert.deepEqual(mergeValue("list", ["a"], "not-an-array", isConcat), "not-an-array");
  assert.deepEqual(mergeValue("list", "x", ["b"], isConcat), ["b"]);
});

test("resolveSettings: five layers, highest precedence wins per key, layer recorded", () => {
  const contributions: ReadonlyArray<LayerContribution> = [
    { layer: "packaged_default", values: { provider: "fixture", model: "packaged", maxTokens: 4096 } },
    { layer: "system", values: { provider: "openai-compatible" } },
    { layer: "user", values: { model: "user-model" } },
    { layer: "project", values: { model: "project-model" } },
    { layer: "cli_flag", values: { maxTokens: 1024 } },
  ];
  const resolved = resolveSettings(contributions);

  assert.deepEqual(resolved["provider"], { value: "openai-compatible", layer: "system" });
  assert.deepEqual(resolved["model"], { value: "project-model", layer: "project" });
  assert.deepEqual(resolved["maxTokens"], { value: 1024, layer: "cli_flag" });
});

test("resolveSettings is order-independent (it sorts by precedence internally)", () => {
  const forward: ReadonlyArray<LayerContribution> = [
    { layer: "packaged_default", values: { model: "packaged" } },
    { layer: "user", values: { model: "user" } },
    { layer: "cli_flag", values: { model: "flag" } },
  ];
  const shuffled: ReadonlyArray<LayerContribution> = [
    { layer: "cli_flag", values: { model: "flag" } },
    { layer: "packaged_default", values: { model: "packaged" } },
    { layer: "user", values: { model: "user" } },
  ];

  assert.deepEqual(resolveSettings(forward), resolveSettings(shuffled));
  assert.deepEqual(resolveSettings(shuffled)["model"], { value: "flag", layer: "cli_flag" });
});

test("resolveSettings: a key only in a low layer keeps that layer", () => {
  const resolved = resolveSettings([
    { layer: "packaged_default", values: { format: "text" } },
    { layer: "user", values: { model: "m" } },
  ]);
  assert.deepEqual(resolved["format"], { value: "text", layer: "packaged_default" });
  assert.deepEqual(resolved["model"], { value: "m", layer: "user" });
});

test("resolveSettings: a missing layer (empty values) contributes nothing", () => {
  const resolved = resolveSettings([
    { layer: "packaged_default", values: { provider: "fixture" } },
    { layer: "user", values: {} },
  ]);
  assert.deepEqual(resolved["provider"], { value: "fixture", layer: "packaged_default" });
});
