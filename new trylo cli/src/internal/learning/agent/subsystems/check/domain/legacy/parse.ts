import { err, ok } from "../../../../../../tooling/contract/result.js";
import type { ToolEvolutionSample } from "../../../../../domains/tool/evolution/contracts.js";
import { decodeToolLearningRecipe } from "../../../../../domains/tool/evolution/pipeline.js";
import { isJsonValue, jsonBytes, keysAre, parseToolEvolutionCandidate, recordOf, textOf } from "../../../../../domains/tool/evolution/parse.js";
import type { CheckCorrection, CheckObservation, CheckResult } from "./contracts.js";

const MAX_OBSERVATION_BYTES = 512 * 1024;
const SOURCE_KINDS = ["task_result", "false_negative", "false_positive", "explicit_correction"];

/** Reject unknown keys, including any claimed permissions, verdicts or acceptance power. */
export function parseCheckObservation(raw: unknown): CheckResult<CheckObservation> {
  if (!isJsonValue(raw) || jsonBytes(raw) > MAX_OBSERVATION_BYTES || !recordOf(raw)
    || !keysAre(raw, ["schemaVersion", "type", "observationId", "scope", "capability", "requirementRef", "source", "baselineRecipe", "sample", "controls"], ["correction"])
    || raw.schemaVersion !== 1 || raw.type !== "check_observation" || !textOf(raw.observationId, 160)
    || !textOf(raw.scope, 512) || !textOf(raw.capability, 512) || !textOf(raw.requirementRef, 512)) {
    return err("invalid_observation", "observation must be bounded v1 JSON with exact keys and source coordinates");
  }

  const source = raw.source;
  if (!recordOf(source) || !keysAre(source, ["kind", "ref", "runId"])
    || !SOURCE_KINDS.some(kind => kind === source.kind) || !textOf(source.ref, 512) || !textOf(source.runId, 160)) {
    return err("invalid_observation", "source needs a known kind, evidence reference and run identity");
  }

  const baselineRecipe = decodeToolLearningRecipe(raw.baselineRecipe);
  const sample = decodeSample(raw.sample);
  if (baselineRecipe === undefined || sample === undefined) return err("invalid_observation", "recipe or additional sample is invalid");

  if (baselineRecipe.request.scope !== raw.scope || baselineRecipe.request.capability !== raw.capability) {
    return err("scope_mismatch", "observation cannot widen the recipe scope or change its capability");
  }

  if (!recordOf(raw.controls) || !keysAre(raw.controls, ["faulty", "valid"])) return err("invalid_observation", "two distinct execution controls are required");

  const faulty = parseToolEvolutionCandidate(JSON.stringify(raw.controls.faulty));
  const valid = parseToolEvolutionCandidate(JSON.stringify(raw.controls.valid));
  if (!faulty.ok || !valid.ok || faulty.value.source === valid.value.source) return err("invalid_observation", "controls must be valid candidates with different executable sources");

  const correction = raw.correction === undefined ? undefined : decodeCorrection(raw.correction);
  if ((raw.correction !== undefined && correction === undefined)
    || (source.kind === "explicit_correction" && correction === undefined)
    || (correction !== undefined && source.kind !== "explicit_correction" && source.kind !== "false_positive")) {
    return err("invalid_observation", "only attributed explicit correction or false-positive evidence may replace an expectation");
  }

  return ok({ schemaVersion: 1, type: "check_observation", observationId: raw.observationId,
    scope: raw.scope, capability: raw.capability, requirementRef: raw.requirementRef,
    source: { kind: source.kind as CheckObservation["source"]["kind"], ref: source.ref, runId: source.runId },
    baselineRecipe, sample, controls: { faulty: faulty.value, valid: valid.value },
    ...(correction === undefined ? {} : { correction }) });
}

function decodeCorrection(raw: unknown): CheckCorrection | undefined {
  if (!recordOf(raw) || !keysAre(raw, ["targetVersionId", "appliesTo"]) || !textOf(raw.targetVersionId, 160) || !recordOf(raw.appliesTo)) return undefined;

  const applies = raw.appliesTo;
  if (applies.kind === "task" && keysAre(applies, ["kind", "taskId"]) && textOf(applies.taskId, 160)) {
    return { targetVersionId: raw.targetVersionId, appliesTo: { kind: "task", taskId: applies.taskId } };
  }

  if ((applies.kind === "class" || applies.kind === "long_term") && keysAre(applies, ["kind"])) {
    return { targetVersionId: raw.targetVersionId, appliesTo: { kind: applies.kind } };
  }

  return undefined;
}

function decodeSample(raw: unknown): ToolEvolutionSample | undefined {
  if (!isJsonValue(raw) || !recordOf(raw) || jsonBytes(raw) > 16 * 1024
    || !keysAre(raw, ["sampleId", "role", "input", "expected"]) || !textOf(raw.sampleId, 128)
    || (raw.role !== "source" && raw.role !== "variation" && raw.role !== "counterexample") || !recordOf(raw.expected)) return undefined;

  const expected = raw.expected;
  if (expected.kind === "value" && keysAre(expected, ["kind", "value"]) && isJsonValue(expected.value) && isJsonValue(raw.input)) {
    return { sampleId: raw.sampleId, role: raw.role, input: structuredClone(raw.input), expected: { kind: "value", value: structuredClone(expected.value) } };
  }

  if (raw.role !== "source" && expected.kind === "error" && keysAre(expected, ["kind", "code"]) && textOf(expected.code, 128) && isJsonValue(raw.input)) {
    return { sampleId: raw.sampleId, role: raw.role, input: structuredClone(raw.input), expected: { kind: "error", code: expected.code } };
  }

  return undefined;
}
