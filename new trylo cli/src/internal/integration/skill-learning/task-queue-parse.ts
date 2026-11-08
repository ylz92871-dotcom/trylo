import { contentHashOf } from "../../learning/control/hash.js";
import { parseSkillTaskFamily } from "../../learning/domains/skill/index.js";
import type { SkillTaskQualification } from "./task-contract.js";
import type { SkillTaskQueueEvent, SkillTaskQueueInput, SkillTaskQueueOutcome } from "./task-queue-contract.js";

export function skillTaskQueueKey(task: SkillTaskQueueInput): string {
  return `skill-intake:${contentHashOf([task.sessionId, task.turnId, task.qualification.ref])}`;
}

export function parseTaskQueueInput(raw: unknown, workspaceId: string): SkillTaskQueueInput | undefined {
  if (!record(raw) || !keys(raw, ["workspaceId", "sessionId", "turnId", "fromSequence", "sourceSequence", "qualification", "expectedFamily", "checker", "usedSkill", "derivationKey"])
    || raw.workspaceId !== workspaceId || !text(raw.sessionId, 512) || !text(raw.turnId, 512)
    || !integer(raw.fromSequence, 0) || !integer(raw.sourceSequence, raw.fromSequence)
    || !record(raw.expectedFamily) || !keys(raw.expectedFamily, ["id", "intentClass", "checkKind", "language", "repoKind", "checkSchema"])) return undefined;

  const qualification = parseQualification(raw.qualification), family = parseSkillTaskFamily(raw.expectedFamily), checker = raw.checker;
  if (qualification === undefined || !family.ok || !record(checker) || !keys(checker, ["id", "command", "verifierFiles"])
    || !text(checker.id, 256) || !text(checker.command, 4096) || !record(checker.verifierFiles)) return undefined;

  const files = Object.entries(checker.verifierFiles);
  if (files.length < 1 || files.length > 32 || files.some(([file, hash]) => !safeRelativeFile(file) || !hashText(hash))) return undefined;

  const verifierFiles: Record<string, string> = {};

  for (const [file, hash] of files) if (hashText(hash)) Object.defineProperty(verifierFiles, file, { value: hash, enumerable: true });

  const used = raw.usedSkill;
  if (used !== undefined && (!record(used) || !keys(used, ["versionId", "variantId", "contentHash"])
    || !text(used.versionId, 512) || !text(used.variantId, 512) || !hashText(used.contentHash))) return undefined;

  if (raw.derivationKey !== undefined && !text(raw.derivationKey, 512)) return undefined;

  return { workspaceId, sessionId: raw.sessionId, turnId: raw.turnId, fromSequence: raw.fromSequence, sourceSequence: raw.sourceSequence,
    qualification, expectedFamily: family.value, checker: { id: checker.id, command: checker.command, verifierFiles },
    ...(record(used) && text(used.versionId, 512) && text(used.variantId, 512) && hashText(used.contentHash) ? {
      usedSkill: { versionId: used.versionId, variantId: used.variantId, contentHash: used.contentHash },
    } : {}), ...(text(raw.derivationKey, 512) ? { derivationKey: raw.derivationKey } : {}) };
}

export function parseTaskQueueOutcome(raw: unknown): SkillTaskQueueOutcome | undefined {
  if (!record(raw)) return undefined;

  if (raw.kind === "processed" && keys(raw, ["kind", "experienceId", "experienceHash"]) && text(raw.experienceId, 512)
    && (raw.experienceHash === undefined || hashText(raw.experienceHash))) return { kind: "processed", experienceId: raw.experienceId,
      ...(hashText(raw.experienceHash) ? { experienceHash: raw.experienceHash } : {}) };

  if ((raw.kind === "extraction_failure" || raw.kind === "cancelled") && keys(raw, ["kind", "reason"]) && text(raw.reason, 256)) {
    return { kind: raw.kind, reason: raw.reason };
  }

  return undefined;
}

export function parseTaskQueueEvent(raw: unknown, workspaceId: string): SkillTaskQueueEvent | undefined {
  if (!record(raw) || !text(raw.key, 128)) return undefined;

  if (raw.kind === "enqueue" && keys(raw, ["kind", "key", "task", "maxAttempts"]) && integer(raw.maxAttempts, 1, 8)) {
    const task = parseTaskQueueInput(raw.task, workspaceId);
    return task !== undefined && skillTaskQueueKey(task) === raw.key ? { kind: "enqueue", key: raw.key, task, maxAttempts: raw.maxAttempts } : undefined;
  }

  if (!integer(raw.attempt, 1, 8) || !text(raw.retryRevision, 512)) return undefined;

  if (raw.kind === "claim" && keys(raw, ["kind", "key", "attempt", "retryRevision"])) {
    return { kind: "claim", key: raw.key, attempt: raw.attempt, retryRevision: raw.retryRevision };
  }

  if (raw.kind === "settle" && keys(raw, ["kind", "key", "attempt", "retryRevision", "result"])) {
    const result = parseTaskQueueOutcome(raw.result);
    return result === undefined ? undefined : { kind: "settle", key: raw.key, attempt: raw.attempt, retryRevision: raw.retryRevision, result };
  }

  return undefined;
}

function parseQualification(raw: unknown): SkillTaskQualification | undefined {
  if (!record(raw) || !text(raw.ref, 1024)) return undefined;

  if (raw.kind === "external_check" && keys(raw, ["kind", "ref", "outcome", "checks"])
    && (raw.outcome === "success" || raw.outcome === "failure") && Array.isArray(raw.checks) && raw.checks.length > 0 && raw.checks.length <= 128) {
    const checks: { label: string; eventId: string }[] = [];
    for (const item of raw.checks) {
      if (!record(item) || !keys(item, ["label", "eventId"]) || !text(item.label, 1024) || !text(item.eventId, 512)) return undefined;
      checks.push({ label: item.label, eventId: item.eventId });
    }
    return { kind: "external_check", ref: raw.ref, outcome: raw.outcome, checks };
  }

  if (raw.outcome !== "failure") return undefined;

  if (raw.kind === "execution_failure" && keys(raw, ["kind", "ref", "outcome", "failureMode"]) && text(raw.failureMode, 4096)) {
    return { kind: "execution_failure", ref: raw.ref, outcome: "failure", failureMode: raw.failureMode };
  }

  const correction = raw.correction;
  if (raw.kind !== "explicit_correction" || !keys(raw, ["kind", "ref", "outcome", "correction"]) || !record(correction)
    || !keys(correction, ["targetEpisodeIds", "scope", "reason"]) || !Array.isArray(correction.targetEpisodeIds)
    || correction.targetEpisodeIds.length < 1 || correction.targetEpisodeIds.length > 256 || !correction.targetEpisodeIds.every(id => text(id, 512))
    || (correction.scope !== "task" && correction.scope !== "condition" && correction.scope !== "family") || !text(correction.reason, 4096)) return undefined;

  return { kind: "explicit_correction", ref: raw.ref, outcome: "failure", correction: {
    targetEpisodeIds: correction.targetEpisodeIds, scope: correction.scope, reason: correction.reason,
  } };
}

export function record(raw: unknown): raw is Record<string, unknown> { return typeof raw === "object" && raw !== null && !Array.isArray(raw); }

export function keys(raw: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(raw).every(key => allowed.includes(key)); }

export function text(raw: unknown, max: number): raw is string { return typeof raw === "string" && raw.trim().length > 0 && raw.length <= max; }

export function integer(raw: unknown, min: number, max = Number.MAX_SAFE_INTEGER): raw is number { return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= min && raw <= max; }

function hashText(raw: unknown): raw is string { return typeof raw === "string" && /^[a-f0-9]{64}$/.test(raw); }

function safeRelativeFile(file: string): boolean {
  return text(file, 1024) && !/^[\\/]|^[A-Za-z]:/.test(file) && !file.replaceAll("\\", "/").split("/").some(part => part === ".." || part === "." || part === "");
}
