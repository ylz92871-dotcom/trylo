import type { LearningGrantDraft, LearningGrantFact, LearningGrantUsage } from "./grant-contract.js";

export function isLearningGrantDraft(value: unknown): value is LearningGrantDraft {
  if (!record(value) || value.schemaVersion !== 1 || !text(value.grantId)) return false;

  if (value.kind === "open") return only(value, ["schemaVersion", "grantId", "kind", "subsystem", "workspaceId", "sourceRef", "allowance"])
    && value.subsystem === "skill" && text(value.workspaceId) && text(value.sourceRef) && record(value.allowance)
    && only(value.allowance, ["maxCalls", "maxOutputTokens"]) && natural(value.allowance.maxCalls, 128) && natural(value.allowance.maxOutputTokens, 1_000_000);

  if (value.kind === "reserve") return only(value, ["schemaVersion", "grantId", "kind", "reservationId", "maxOutputTokens"])
    && text(value.reservationId) && natural(value.maxOutputTokens, 1_000_000) && value.maxOutputTokens > 0;

  if (value.kind === "settle") return only(value, ["schemaVersion", "grantId", "kind", "reservationId", "usage"])
    && text(value.reservationId) && isLearningGrantUsage(value.usage);

  return value.kind === "close" && only(value, ["schemaVersion", "grantId", "kind", "reason"])
    && (value.reason === "completed" || value.reason === "cancelled" || value.reason === "failed" || value.reason === "budget_exhausted");
}

export function isLearningGrantFact(value: unknown): value is LearningGrantFact {
  if (!record(value) || !natural(value.boardSequence, Number.MAX_SAFE_INTEGER) || value.boardSequence < 1) return false;
  const { boardSequence: _sequence, ...draft } = value;
  return isLearningGrantDraft(draft);
}

export function isLearningGrantUsage(value: unknown): value is LearningGrantUsage {
  if (!record(value)) return false;

  if (value.kind === "reported") return only(value, ["kind", "inputTokens", "outputTokens", "totalTokens"])
    && natural(value.inputTokens, 1_000_000_000) && natural(value.outputTokens, 1_000_000_000)
    && natural(value.totalTokens, 2_000_000_000) && value.totalTokens >= value.inputTokens + value.outputTokens;

  if (value.kind !== "unknown" || !only(value, ["kind", "reason", "observed"]) || !text(value.reason)) return false;

  if (value.observed === undefined) return true;

  const observed = value.observed;

  return record(observed) && only(observed, ["inputTokens", "outputTokens", "totalTokens"])
    && Object.values(observed).every(item => natural(item, 2_000_000_000));
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function only(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }

function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 1024; }

function natural(value: unknown, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max; }
