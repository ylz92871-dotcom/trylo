import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCentralEffectSupport } from "./effect-support.js";
import type { CentralEffectMeasurement, CentralEffectSupportInput, CentralEffectWindow } from "./effect-support-contract.js";

const target = { key: "target:registered-windows", utilityUnit: "comparison-effect", referenceKey: "cohort:registered",
  baselineRuleKey: "baseline:frozen-v1", windowRef: "window:two-comparisons" };
const measured = (comparisonId: string, candidateUtility: number, revisionRef = `revision:${comparisonId}`): CentralEffectMeasurement => ({
  comparisonId, revisionRef, sourceRef: `checker:${comparisonId}`, outcome: { kind: "measured", candidateUtility, baselineUtility: 0 } });
const window = (unitId: string, measurements: readonly CentralEffectMeasurement[]): CentralEffectWindow => ({
  unitId, revisionRef: `revision:${unitId}`, sourceRef: `registration:${unitId}`,
  comparisonIds: [`${unitId}:a`, `${unitId}:b`], measurements });
const input = (windows: readonly CentralEffectWindow[]): CentralEffectSupportInput => ({ target, comparisonsPerWindow: 2,
  deltaBounds: { minimum: -1, maximum: 1, sourceRef: "objective:per-comparison-support" }, windows });

function ready(source: CentralEffectSupportInput) {
  const result = summarizeCentralEffectSupport(source);
  if (result.status !== "ready") throw new Error(`${result.status}:${result.reason}`);
  return result.value;
}

test("no registered windows yields no historical mean and one partial window retains its missing slot", () => {
  const empty = ready(input([]));

  assert.equal(empty.population, 0);
  assert.equal(empty.actualMeanSupport, null);
  assert.deepEqual(empty.totalGrossSupport, [0, 0]);
  const one = ready(input([window("one", [measured("one:a", .25)])]));

  assert.equal(one.population, 1);
  assert.equal(one.knownComparisons, 1);
  assert.equal(one.unknownComparisons, 1);
  assert.deepEqual(one.actualMeanSupport, [-.75, 1.25]);
  assert.deepEqual(one.windows[0]!.pendingComparisonIds, ["one:b"]);
});

test("pending windows stay in the original denominator instead of blocking or disappearing", () => {
  const source = input([window("partial", [measured("partial:a", .5)]),
    window("complete", [measured("complete:a", -.5), measured("complete:b", -.5)])]);
  const before = JSON.stringify(source), result = ready(source);

  assert.deepEqual(result.totalGrossSupport, [-1.5, .5]);
  assert.deepEqual(result.actualMeanSupport, [-.75, .25]);
  assert.equal(result.population, 2);
  assert.equal(result.completeWindows, 1);
  assert.equal(result.pendingWindows, 1);
  assert.equal(JSON.stringify(source), before);
  assert.equal(result.interpretation, "actual_registered_window_support");
});

test("identical complete windows have a point historical support without requiring nonzero sample variance", () => {
  const source = input([window("one", [measured("one:a", .25), measured("one:b", .25)]),
    window("two", [measured("two:a", .25), measured("two:b", .25)])]);
  const result = ready(source);
  assert.deepEqual(result.actualMeanSupport, [.5, .5]);
  assert.equal(result.unknownComparisons, 0);
  assert.equal(result.completeWindows, 2);
});

test("an effective revision replaces the observed endpoint rather than adding another population member", () => {
  const first = input([window("one", [measured("one:a", .5)])]), original = ready(first);
  const revised = ready({ ...first, windows: [{ ...first.windows[0]!, revisionRef: "revision:corrected-window",
    measurements: [measured("one:a", -.5, "revision:corrected-measurement")] }] });
  assert.equal(revised.population, 1);
  assert.equal(revised.knownComparisons, 1);
  assert.deepEqual(original.actualMeanSupport, [-.5, 1.5]);
  assert.deepEqual(revised.actualMeanSupport, [-1.5, .5]);
  assert.notEqual(revised.supportRef, original.supportRef);
});

test("unknown records and absent records have the same numerical support while retaining their source", () => {
  const source = input([window("one", [{ comparisonId: "one:a", sourceRef: "feedback:pending", revisionRef: "revision:pending",
    outcome: { kind: "unknown", reason: "awaiting_external_check" } }])]);
  const result = ready(source);
  assert.deepEqual(result.actualMeanSupport, [-2, 2]);
  assert.equal(result.unknownComparisons, 2);
  assert.ok(result.sourceRefs.includes("feedback:pending"));
});

test("duplicate units, reused comparisons, unregistered or conflicting measurements cannot inflate support", () => {
  const one = window("one", [measured("one:a", .5)]);
  const cases = [
    input([one, one]),
    input([{ ...one, comparisonIds: ["one:a", "one:a"] }]),
    input([{ ...one, measurements: [measured("outside", .5)] }]),
    input([{ ...one, measurements: [measured("one:a", .5), measured("one:a", -.5, "revision:another")] }]),
    input([{ ...one, measurements: [measured("one:a", 2)] }]),
    { ...input([one]), comparisonsPerWindow: 1 },
  ];

  for (const source of cases) assert.equal(summarizeCentralEffectSupport(source).status, "invalid");
});

test("numeric overflow or an unrepresentable nonzero average is unsupported rather than a zero effect", () => {
  const overflow = summarizeCentralEffectSupport({ ...input([window("one", [])]),
    deltaBounds: { minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE, sourceRef: "objective:huge-support" } });

  assert.equal(overflow.status, "unsupported");
  const tiny = summarizeCentralEffectSupport({ ...input([]), comparisonsPerWindow: 1,
    windows: ["one", "two"].map((unitId, index) => ({ ...window(unitId, []), comparisonIds: [`${unitId}:a`],
      measurements: [measured(`${unitId}:a`, index === 0 ? Number.MIN_VALUE : 0)] })) });

  assert.equal(tiny.status, "unsupported");
});
