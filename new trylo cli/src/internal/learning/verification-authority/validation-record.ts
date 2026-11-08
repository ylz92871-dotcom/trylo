import {
  VALIDATION_STAGE_ORDER,
  type StageResult,
  type ValidationRecord,
} from "../../tooling/contract/types.js";
import { canonicalJson, sha256Hex } from "../control/hash.js";
import { isNonEmptyString, isPlainRecord } from "./parse.js";

/**
 * 结构化验证记录校验（原 `integration/tool/validation-record.ts`，WP-F 上移到
 * authoritative 侧）。
 *
 * 关键认识变化（外审 R2 §3.1）：这个函数**不能**证明独立性。它校验的是记录内部
 * 结构与派生关系，而所有字段值都来自调用方；伪造一张结构自洽的记录只需复制
 * `VALIDATION_STAGE_ORDER`。因此它的正确位置是 **issuance 侧**：verifier/checker
 * composition 在把一个结构完整的记录提升为权威收据时使用它，而不是让 Board
 * mapper 用它充当证据门。
 */

export type ValidationRecordCheck =
  | { readonly ok: true; readonly record: ValidationRecord }
  | { readonly ok: false; readonly detail: string };

export function checkValidationRecord(value: unknown): ValidationRecordCheck {
  if (!isPlainRecord(value)) {
    return { ok: false, detail: "validationRecord must be an object" };
  }

  if (!isNonEmptyString(value.validationId)) {
    return { ok: false, detail: "validationRecord.validationId is required" };
  }

  if (!isNonEmptyString(value.packageVersionId)) {
    return { ok: false, detail: "validationRecord.packageVersionId is required" };
  }

  if (value.actor !== "verifier") {
    return { ok: false, detail: "only a verifier actor may back independent evidence" };
  }

  if (value.verdict !== "pass" && value.verdict !== "fail") {
    return { ok: false, detail: "validationRecord.verdict must be pass or fail" };
  }

  const stages = value.stages;
  if (!Array.isArray(stages) || stages.length !== VALIDATION_STAGE_ORDER.length) {
    return {
      ok: false,
      detail: `validationRecord.stages must contain all ${String(VALIDATION_STAGE_ORDER.length)} stages in order`,
    };
  }

  const checkedStages: StageResult[] = [];

  for (let index = 0; index < stages.length; index += 1) {
    const stage: unknown = stages[index];
    const stageName = VALIDATION_STAGE_ORDER[index];
    if (!isPlainRecord(stage) || stageName === undefined) {
      return { ok: false, detail: `stage ${String(index)} is malformed` };
    }

    if (stage.stage !== stageName) {
      return { ok: false, detail: `stage ${String(index)} must be ${String(stageName)}` };
    }

    if (typeof stage.passed !== "boolean" || !isNonEmptyString(stage.detail)) {
      return { ok: false, detail: `stage ${String(stageName)} needs a boolean passed and a detail` };
    }

    checkedStages.push({ stage: stageName, passed: stage.passed, detail: stage.detail });
  }

  const allPassed = checkedStages.every((stage) => stage.passed);
  if (value.verdict === "pass" && !allPassed) {
    return { ok: false, detail: "a pass validation record cannot contain failed stages" };
  }

  if (value.verdict === "fail" && allPassed) {
    return { ok: false, detail: "a fail validation record cannot have all stages passed" };
  }

  return {
    ok: true,
    record: {
      validationId: value.validationId,
      packageVersionId: value.packageVersionId,
      stages: checkedStages,
      verdict: value.verdict,
      actor: "verifier",
    },
  };
}

/**
 * 收据摘要的**派生**，不是回显（外审 R2 §3.1 的根本关闭点）：
 * 摘要由 authority 从它自己校验过的记录算出，调用方提供的摘要一律不被采信。
 */
export function deriveChecksDigest(record: ValidationRecord): string {
  return `checks:${sha256Hex(canonicalJson(record.stages)).slice(0, 32)}`;
}

export function deriveSourceDigest(record: ValidationRecord): string {
  return `source:${sha256Hex(
    canonicalJson({
      validationId: record.validationId,
      packageVersionId: record.packageVersionId,
      verdict: record.verdict,
    }),
  ).slice(0, 32)}`;
}
