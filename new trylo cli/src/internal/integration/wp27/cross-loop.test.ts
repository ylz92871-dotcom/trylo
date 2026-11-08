import assert from "node:assert/strict";
import test from "node:test";
import { CROSS_LOOP_STAGES, evaluateCrossLoop, type StageOutcome } from "./cross-loop.js";

function passedOutcomes(): { stage: (typeof CROSS_LOOP_STAGES)[number]; result: "passed"; evidenceRef: string }[] {
  return CROSS_LOOP_STAGES.map((stage) => ({ stage, result: "passed" as const, evidenceRef: `ev/${stage}` }));
}

test("WP27.2: 八阶段全 passed 才 closed", () => {
  const verdict = evaluateCrossLoop(passedOutcomes());
  assert.equal(verdict.kind, "closed");
});

test("WP27.2 反例：permission denied 终局为 blocked，不继续冒充通过", () => {
  const verdict = evaluateCrossLoop([
    { stage: "input", result: "passed", evidenceRef: "ev/input" },
    { stage: "permission", result: "blocked", evidenceRef: "ev/deny" },
    { stage: "process", result: "passed", evidenceRef: "ev/process" },
  ]);

  assert.equal(verdict.kind, "blocked");

  if (verdict.kind === "blocked") {
    assert.equal(verdict.blockedStage, "permission");
  }
});

test("WP27.2 反例：process failed 优先于后段通过", () => {
  const verdict = evaluateCrossLoop([
    ...passedOutcomes().filter((outcome) => outcome.stage !== "process"),
    { stage: "process", result: "failed", evidenceRef: "ev/kill-tree" },
  ]);

  assert.equal(verdict.kind, "failed");

  if (verdict.kind === "failed") {
    assert.equal(verdict.failedStage, "process");
  }
});

test("WP27.2 反例：缺消费者与 unknown 保持 partial，不合成 done", () => {
  const missing = evaluateCrossLoop(passedOutcomes().slice(0, 5));

  assert.equal(missing.kind, "partial");
  const unknown = evaluateCrossLoop([
    ...passedOutcomes().slice(0, 7),
    { stage: "cancel_recover", result: "unknown", evidenceRef: "ev/todo" },
  ]);

  assert.equal(unknown.kind, "partial");

  if (unknown.kind === "partial") {
    assert.ok(unknown.pendingStages.includes("cancel_recover"));
  }
});

test("WP27.2 红例：无法识别的结果词不得升格为 closed", () => {
  const misspelled = evaluateCrossLoop([
    { stage: "input", result: "pass" as unknown as StageOutcome["result"], evidenceRef: "ev/input" },
    ...passedOutcomes().filter((outcome) => outcome.stage !== "input"),
  ]);

  assert.equal(misspelled.kind, "partial");

  if (misspelled.kind === "partial") {
    assert.ok(misspelled.pendingStages.includes("input"));
  }
});

test("WP27.2 红例：passed 缺证据引用不算通过", () => {
  const noEvidence = evaluateCrossLoop([
    { stage: "input", result: "passed", evidenceRef: "" },
    ...passedOutcomes().filter((outcome) => outcome.stage !== "input"),
  ]);

  assert.equal(noEvidence.kind, "partial");

  if (noEvidence.kind === "partial") {
    assert.ok(noEvidence.pendingStages.includes("input"));
  }
});

test("WP27.2 红例：同一阶段结果冲突不得按先到者结算", () => {
  const deniedAfterPass = evaluateCrossLoop([
    ...passedOutcomes(),
    { stage: "permission", result: "blocked", evidenceRef: "ev/deny-late" },
  ]);

  assert.equal(deniedAfterPass.kind, "failed");

  if (deniedAfterPass.kind === "failed") {
    assert.equal(deniedAfterPass.failedStage, "permission");
  }
});
