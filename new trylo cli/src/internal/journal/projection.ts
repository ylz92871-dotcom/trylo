import type { LearningObservation, TurnOutcome } from "../learning/control/contracts.js";
import type { ReasonCode } from "../learning/control/reasons.js";
import { FORBIDDEN_FACT_FIELDS } from "./whitelist.js";

export type ExecutionFact = {
  readonly eventId: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly sequence?: number;
  readonly scope?: string;
  readonly taskFamily?: string;
  readonly snapshotId?: string;
  readonly assetVersions?: Readonly<Record<string, string>>;
  readonly outcome?: TurnOutcome;
  readonly verdict?: LearningObservation["verdict"];
  readonly latencyMs?: number;
  readonly tokenCost?: number;
  readonly causalRefs?: ReadonlyArray<string>;
  readonly rawBody?: string;
  readonly secret?: string;
  readonly body?: string;
  readonly hiddenReasoning?: string;
  readonly reason?: string;
};

export type LearningProjection =
  | { readonly ok: true; readonly observations: ReadonlyArray<LearningObservation> }
  | { readonly ok: false; readonly reason: ReasonCode; readonly detail: string };

export function projectFacts(
  facts: ReadonlyArray<ExecutionFact>,
  collect: boolean,
): LearningProjection {
  // Collection consent applies before any fact is converted into a learning observation.
  if (!collect) {
    return { ok: true, observations: [] };
  }
  try {
    return { ok: true, observations: facts.map(toObservation) };
  } catch (err) {
    return {
      ok: false,
      reason: "board_unavailable",
      detail: err instanceof Error ? err.message : "projection failed",
    };
  }
}

export function toObservation(fact: ExecutionFact): LearningObservation {
  const observation: LearningObservation = {
    observationId: `obs:${fact.eventId}`,
    scope: fact.scope ?? "unknown",
    taskFamily: fact.taskFamily ?? fact.kind,
    assetRefs: fact.assetVersions ?? {},
    outcome: fact.outcome ?? "unknown",
    causalRefs: fact.causalRefs ?? [fact.eventId],
    privacyClass: "summary",
    occurredAt: fact.occurredAt,
    inputRef: fact.eventId,
  };
  return withOptional(observation, fact);
}

export function observationLeaksForbidden(
  observation: LearningObservation,
  fact: ExecutionFact,
): boolean {
  const serialized = JSON.stringify(observation);

  for (const field of FORBIDDEN_FACT_FIELDS) {
    const value = fact[field];
    if (typeof value === "string" && value.length > 0 && serialized.includes(value)) {
      return true;
    }
  }

  return false;
}

function withOptional(
  observation: LearningObservation,
  fact: ExecutionFact,
): LearningObservation {
  let next = observation;

  if (fact.snapshotId !== undefined) {
    next = { ...next, snapshotRef: fact.snapshotId };
  }

  if (fact.verdict !== undefined) {
    next = { ...next, verdict: fact.verdict };
  }

  if (fact.tokenCost !== undefined) {
    next = { ...next, tokenCost: fact.tokenCost };
  }

  if (fact.latencyMs !== undefined) {
    next = { ...next, latencyMs: fact.latencyMs };
  }

  if (fact.sequence !== undefined) {
    next = { ...next, boardSequence: fact.sequence };
  }

  if (fact.reason !== undefined) {
    next = { ...next, reason: fact.reason };
  }

  return next;
}
