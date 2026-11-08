import { submitDraftCommand } from "../shared/board-command.js";
import { ruleIdentity } from "../shared/dual-save.js";
import { scanForbiddenBody } from "../shared/forbidden-scan.js";
import type { ParseResult } from "../shared/parse.js";
import { parseSkillTaskFamily, sameSkillTaskFamily } from "./conditions.js";
import type { SkillDraft, SkillExampleRef, SkillVariant } from "./types.js";

/** v1 conditioned drafts only. Legacy drafts lack executable conditions and fail closed. */
export function parseSkillDraft(value: unknown): ParseResult<SkillDraft> {
  if (!isRecord(value) || value.kind !== "skill" || value.status !== "draft" ||
    !nonEmpty(value.id) || !nonEmpty(value.name) || !nonEmpty(value.trigger) ||
    typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1 ||
    value.permissionClaim !== false || !nonEmpty(value.identity) ||
    !strings(value.steps) || !strings(value.checks) || !strings(value.failureModes) ||
    !strings(value.positiveRules) || !strings(value.negativeRules)) {
    return invalid("invalid conditioned skill draft fields");
  }

  const taskFamily = parseSkillTaskFamily(value.taskFamily);
  const variants = parseVariants(value.variants);
  const positive = parseExamples(value.positiveExamples, "success");
  const negative = parseExamples(value.negativeExamples, "failure");

  if (!taskFamily.ok) { return taskFamily; }

  if (!variants.ok) { return variants; }

  if (!positive.ok) { return positive; }

  if (!negative.ok) { return negative; }

  const scope = value.scope;
  const provenance = value.provenance;
  const command = value.command;
  if (!isRecord(scope) || scope.kind !== "task_family" || !nonEmpty(scope.id) ||
    !isRecord(provenance) || provenance.source !== "inferred_from_observations" ||
    provenance.createdBy !== "skill_inducer" || !strings(provenance.observationRefs) ||
    !isRecord(command) || command.kind !== "submit_draft" || command.assetKind !== "skill" ||
    command.payloadId !== value.id || command.commandId !== submitDraftCommand("skill", value.id).commandId) {
    return invalid("skill draft scope, provenance or proposal command is invalid");
  }

  const preferred = variants.value[0];
  if (preferred === undefined || !sameSkillTaskFamily(taskFamily.value, preferred.taskFamily) ||
    !equalStrings(value.steps, preferred.steps) || !equalStrings(value.checks, preferred.checks) ||
    value.identity !== ruleIdentity(value.steps) ||
    !equalStrings(value.positiveRules, value.steps.map((step) => `do: ${step}`)) ||
    !equalStrings(value.negativeRules, value.failureModes.map((mode) => `avoid: ${mode}`))) {
    return invalid("skill preferred projection differs from its conditioned variant");
  }

  const observed = provenance.observationRefs;
  const allRefs = [
    ...positive.value.map((example) => example.episodeId), ...negative.value.map((example) => example.episodeId),
    ...variants.value.flatMap((variant) => [...variant.supportEpisodeIds, ...variant.correctionRefs,
      ...variant.stepEvidence.flatMap((row) => row.episodeIds), ...variant.checkEvidence.flatMap((row) => row.episodeIds),
      ...variant.failureLessons.flatMap((row) => row.episodeIds)]),
  ];
  if (allRefs.some((ref) => !observed.includes(ref)) || variants.value.some((variant) =>
    variant.taskFamily.id !== taskFamily.value.id || variant.taskFamily.intentClass !== taskFamily.value.intentClass ||
    variant.supportEpisodeIds.some((ref) => !positive.value.some((example) => example.episodeId === ref)))) {
    return invalid("skill evidence references are not attributable to this draft");
  }

  const body = [value.name, value.trigger, ...value.steps, ...value.checks, ...value.failureModes,
    ...value.positiveRules, ...value.negativeRules, ...variants.value.flatMap((variant) =>
      [...variant.steps, ...variant.checks, ...variant.failureLessons.map((lesson) => lesson.failureMode)])];
  if (scanForbiddenBody(body).length > 0) {
    return invalid("skill draft contains forbidden authority or tool mutation instructions");
  }

  return { ok: true, value: {
    kind: "skill", status: "draft", id: value.id, name: value.name, version: value.version,
    trigger: value.trigger, taskFamily: taskFamily.value, variants: variants.value,
    steps: value.steps, checks: value.checks, failureModes: value.failureModes,
    positiveExamples: positive.value, negativeExamples: negative.value,
    positiveRules: value.positiveRules, negativeRules: value.negativeRules,
    scope: { kind: "task_family", id: scope.id }, identity: value.identity, permissionClaim: false,
    provenance: { source: "inferred_from_observations", createdBy: "skill_inducer", observationRefs: observed },
    command: submitDraftCommand("skill", value.id),
  } };
}

function parseVariants(value: unknown): ParseResult<SkillVariant[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid("skill requires conditioned variants");
  }

  const variants: SkillVariant[] = [];

  for (const item of value) {
    const parsed = parseVariant(item);
    if (!parsed.ok) { return parsed; }
    variants.push(parsed.value);
  }

  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) {
    return invalid("skill variant ids must be unique");
  }

  return { ok: true, value: variants };
}

function parseVariant(value: unknown): ParseResult<SkillVariant> {
  if (!isRecord(value) || !nonEmpty(value.id) || !strings(value.steps) || value.steps.length < 2 ||
    !strings(value.checks) || value.checks.length === 0 || !strings(value.supportEpisodeIds) || !strings(value.correctionRefs)) {
    return invalid("invalid conditioned skill variant");
  }

  const family = parseSkillTaskFamily(value.taskFamily);
  const steps = parseEvidence(value.stepEvidence, "step");
  const checks = parseEvidence(value.checkEvidence, "check");
  const lessons = parseEvidence(value.failureLessons, "failureMode");

  if (!family.ok) { return family; }

  if (!steps.ok) { return steps; }

  if (!checks.ok) { return checks; }

  if (!lessons.ok) { return lessons; }

  const supportEpisodeIds = value.supportEpisodeIds;
  if (!equalStrings(value.steps, steps.value.map((row) => row.label)) ||
    !equalStrings(value.checks, checks.value.map((row) => row.label)) ||
    steps.value.some((row) => !equalStrings(row.episodeIds, supportEpisodeIds)) ||
    (supportEpisodeIds.length > 0 && checks.value.some((row) => row.episodeIds.length === 0)) ||
    [...steps.value, ...checks.value].some((row) => row.episodeIds.some((ref) => !supportEpisodeIds.includes(ref)))) {
    return invalid("skill steps and checks must carry their successful evidence");
  }

  return { ok: true, value: {
    id: value.id, taskFamily: family.value, steps: value.steps, checks: value.checks,
    supportEpisodeIds: value.supportEpisodeIds, correctionRefs: value.correctionRefs,
    stepEvidence: steps.value.map((row) => ({ step: row.label, episodeIds: row.episodeIds })),
    checkEvidence: checks.value.map((row) => ({ check: row.label, episodeIds: row.episodeIds })),
    failureLessons: lessons.value.map((row) => ({ failureMode: row.label, episodeIds: row.episodeIds })),
  } };
}

function parseExamples(value: unknown, outcome: "success" | "failure"): ParseResult<SkillExampleRef[]> {
  if (!Array.isArray(value)) { return invalid("skill examples must be an array"); }

  const examples: SkillExampleRef[] = [];

  for (const item of value) {
    if (!isRecord(item) || !nonEmpty(item.episodeId) || item.outcome !== outcome) {
      return invalid("invalid skill example reference");
    }
    examples.push({ episodeId: item.episodeId, outcome });
  }

  return { ok: true, value: examples };
}

function parseEvidence(value: unknown, key: string): ParseResult<{ readonly label: string; readonly episodeIds: readonly string[] }[]> {
  if (!Array.isArray(value)) { return invalid("skill evidence must be an array"); }

  const rows: { label: string; episodeIds: readonly string[] }[] = [];

  for (const item of value) {
    if (!isRecord(item) || !nonEmpty(item[key]) || !strings(item.episodeIds)) {
      return invalid("invalid skill evidence row");
    }
    rows.push({ label: item[key], episodeIds: item.episodeIds });
  }

  return { ok: true, value: rows };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(nonEmpty); }

function equalStrings(a: readonly string[], b: readonly string[]): boolean { return JSON.stringify(a) === JSON.stringify(b); }

function invalid(reason: string): ParseResult<never> { return { ok: false, reason }; }
