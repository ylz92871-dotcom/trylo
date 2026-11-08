import assert from "node:assert/strict";
import test from "node:test";
import { observation } from "../../../../../tooling/testing/fixtures.js";
import { detectToolGap } from "./gap-detector.js";

test("single incidental tool failure does not open a gap", () => {
  const result = detectToolGap([
    observation({ observationId: "o1", kind: "tool_failure" }),
  ]);

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.value.decision, "no_change");

  if (result.value.decision === "no_change") {
    assert.equal(result.value.reason, "below_repeat_threshold");
  }
});

test("repeated failures with observation ids produce ToolGapDraft", () => {
  const result = detectToolGap([
    observation({ observationId: "o1", kind: "tool_failure" }),
    observation({ observationId: "o2", kind: "tool_failure" }),
    observation({ observationId: "o3", kind: "tool_failure" }),
  ]);

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.value.decision, "gap");

  if (result.value.decision === "gap") {
    assert.equal(result.value.gap.kind, "repeated_tool_failure");
    assert.deepEqual(result.value.gap.observationIds, ["o1", "o2", "o3"]);
    assert.equal(result.value.gap.repeatCount, 3);
  }
});

test("existing tool success is no_change", () => {
  const result = detectToolGap([
    observation({ observationId: "s1", kind: "success" }),
    observation({ observationId: "s2", kind: "success" }),
    observation({ observationId: "f1", kind: "tool_failure" }),
  ]);

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.value.decision, "no_change");

  if (result.value.decision === "no_change") {
    assert.equal(result.value.reason, "existing_tool_good_enough");
  }
});

test("gap without observation ids is invalid", () => {
  const result = detectToolGap([
    observation({ observationId: "", kind: "tool_not_found" }),
  ]);

  assert.equal(result.ok, false);

  if (result.ok) {
    return;
  }

  assert.equal(result.code, "invalid_observation");
});

test("high criticality without fallback uses a lower repeat threshold", () => {
  const result = detectToolGap([
    observation({
      observationId: "c1",
      kind: "tool_not_found",
      criticality: "high",
      fallbackAvailable: false,
    }),
    observation({
      observationId: "c2",
      kind: "tool_not_found",
      criticality: "high",
      fallbackAvailable: false,
    }),
  ]);

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.value.decision, "gap");
});
