import assert from "node:assert/strict";
import test from "node:test";
import { ExactTiming } from "./exact.js";
import { analyzeLearningStartWindow } from "./start-window.js";
import type { LearningStartWindowModel } from "./start-window-contract.js";

const header = { schemaVersion: 1 as const, modelKind: "fixed_program_no_observation_start" as const,
  basisRef: "basis:test", evaluationRef: "evaluation:T", programRef: "program:fixed", utilityUnit: "utility:v1", timeUnit: "time:v1" };
const profile = [{ u: 0, v: 1, load: 1 }];

function simple(): LearningStartWindowModel {
  return { ...header, T: 2, legalStart: { lo: 0, hi: 1 }, useRule: "completion_lte_useBy", extraWaitRate: 0,
    interference: [{ from: 0, to: 2, rate: 0 }],
    worlds: [{ weight: 1, duration: 0, useBy: 2, gross: { a: 0, b: 0, c: 4 }, futureFee: 1, profile: [] }] };
}

function negativeGross(): LearningStartWindowModel {
  return { ...simple(), legalStart: { lo: 0, hi: 2 }, extraWaitRate: 1, worlds: [
    { weight: 1, duration: 0, useBy: 1, gross: { a: 0, b: 0, c: -4 }, futureFee: 0, profile: [] },
    { weight: 1, duration: 0, useBy: 2, gross: { a: 0, b: 0, c: 6 }, futureFee: 0, profile: [] },
  ] };
}

test("physical phase/profile offset creates the best legal start", () => {
  const model: LearningStartWindowModel = { ...simple(), extraWaitRate: "1/8",
    interference: [{ from: 0, to: 0.75, rate: 2 }, { from: 0.75, to: 1.5, rate: 0 }, { from: 1.5, to: 2, rate: 10 }],
    worlds: [{ weight: 1, duration: 1, useBy: 2, gross: { a: 0, b: 0, c: 4 }, futureFee: 0, profile }] };
  const result = analyzeLearningStartWindow(JSON.stringify(model));

  assert.ok(result.status === "max_attained");
  assert.equal(result.maximizer.start, "1/2");
  assert.equal(result.maximumOrSupremum, "55/16");
  assert.ok(result.actualBoundaryValues.some(point => point.at === "1/2" && point.kinds.includes("interference_phase_offset")));
  assert.equal(result.gap, "0/1");
  assert.equal(result.requestedRegret, null);
});

test("worlds mix coefficients before the common concave vertex is chosen", () => {
  const model: LearningStartWindowModel = { ...simple(), T: 4, legalStart: { lo: 0, hi: 3 },
    interference: [{ from: 0, to: 3.5, rate: 0 }, { from: 3.5, to: 4, rate: "1/8" }], worlds: [
      { weight: 1, duration: 1, useBy: 4, gross: { a: "-1/16", b: "1/8", c: "11/16" }, futureFee: 0, profile },
      { weight: 1, duration: 1, useBy: 4, gross: { a: "-1/16", b: "3/8", c: "3/16" }, futureFee: 0, profile },
    ] };
  const result = analyzeLearningStartWindow(JSON.stringify(model));

  assert.ok(result.status === "max_attained");
  assert.equal(result.maximizer.start, "2/1");
  assert.equal(result.maximumOrSupremum, "11/16");
  assert.ok(result.cells.some(cell => cell.vertex?.start === "2/1" && cell.netQuadratic.b === "1/4"));
});

test("soft negative-gross boundary has an unattained right supremum and an actual witness", () => {
  const result = analyzeLearningStartWindow(JSON.stringify(negativeGross()));
  assert.ok(result.status === "supremum_unattained");
  assert.equal(result.maximizer, null);
  assert.equal(result.maximumOrSupremum, "2/1");
  assert.equal(result.bestKnown.start, "3/2");
  assert.equal(result.bestKnown.value, "3/2");
  assert.equal(result.gap, "1/2");
  assert.equal(result.actualBoundaryValues.find(point => point.at === "1/1")?.value, "0/1");
  assert.ok(result.supremumLimitSides.some(limit => limit.at === "1/1" && limit.side === "right"));
});

test("external requested regret improves the witness without pretending the supremum is attained", () => {
  const json = JSON.stringify(negativeGross()), original = analyzeLearningStartWindow(json);
  const result = analyzeLearningStartWindow(json, { requestedRegret: "1/8" });

  assert.ok(original.status === "supremum_unattained" && result.status === "supremum_unattained");
  assert.equal(result.modelHash, original.modelHash);
  assert.equal(result.requestedRegret, "1/8");
  assert.equal(result.maximizer, null);
  assert.equal(result.bestKnown.start, "9/8");
  assert.equal(result.bestKnown.value, "15/8");
  assert.equal(result.gap, "1/8");
  assert.ok(result.bestKnown.kinds.includes("requested_regret"));

  for (const epsilon of [0, "-1/8"]) {
    assert.equal(analyzeLearningStartWindow(json, { requestedRegret: epsilon }).status, "invalid_input");
  }
});

test("late output retains future fee and flat-window endpoint membership", () => {
  const model: LearningStartWindowModel = { ...simple(), worlds: [
    { weight: 1, duration: 0, useBy: 0, gross: { a: 0, b: 0, c: -4 }, futureFee: 2, profile: [] },
  ] };
  const result = analyzeLearningStartWindow(JSON.stringify(model));

  assert.ok(result.status === "max_attained");
  assert.equal(result.maximumOrSupremum, "-2/1");
  assert.equal(result.actualBoundaryValues.find(point => point.at === "0/1")?.value, "-6/1");
  assert.deepEqual(result.cooptimalWindows, [{ lo: "0/1", hi: "1/1", value: "-2/1", interior: "open",
    cooptimal: true, includeLo: false, includeHi: true }]);
});

test("a singleton legal interval returns its actual start", () => {
  const result = analyzeLearningStartWindow(JSON.stringify({ ...simple(), legalStart: { lo: "1/2", hi: "1/2" } }));
  assert.ok(result.status === "max_attained");
  assert.equal(result.maximizer.start, "1/2");
  assert.equal(result.maximumOrSupremum, "3/1");
  assert.equal(result.cells.length, 0);
});

test("a non-dyadic vertex and value remain exact instead of becoming Number(4/3)", () => {
  const model: LearningStartWindowModel = { ...simple(), worlds: [
    { weight: 1, duration: 0, useBy: 2, gross: { a: -3, b: 4, c: 0 }, futureFee: 0, profile: [] },
  ] };
  const result = analyzeLearningStartWindow(JSON.stringify(model));
  assert.ok(result.status === "max_attained");
  assert.equal(result.maximizer.start, "2/3");
  assert.equal(result.maximumOrSupremum, "4/3");
  const math = new ExactTiming();

  assert.equal(math.text(math.sub(math.from(result.maximumOrSupremum), math.from(4 / 3))), "1/13510798882111488");
});

test("unsupported closure/rules and limits do not publish a truncated optimum", () => {
  const model = simple(), json = JSON.stringify(model);

  assert.equal(analyzeLearningStartWindow(JSON.stringify({ ...model, basisRef: "" })).status, "invalid_input");
  assert.equal(analyzeLearningStartWindow(JSON.stringify({ ...model, invented: 0 })).status, "invalid_input");
  assert.equal(analyzeLearningStartWindow(JSON.stringify({ ...model, useRule: "completion_lt_useBy" })).status, "unsupported_model");
  const crossing = analyzeLearningStartWindow(JSON.stringify({ ...model, worlds: [
    { ...model.worlds[0]!, duration: 2 },
  ] }));

  assert.ok(crossing.status === "unsupported_model");
  assert.equal(crossing.reason, "start_window_tail_not_supplied");
  const limited = analyzeLearningStartWindow(json, { maxCandidates: 1 });

  assert.equal(limited.status, "planning_limit");
  assert.equal(Object.hasOwn(limited, "bestKnown"), false);
  const numeric = analyzeLearningStartWindow(json, { maxBits: 2 });

  assert.equal(numeric.status, "numeric_limit");
  assert.equal(Object.hasOwn(numeric, "maximumOrSupremum"), false);
});
