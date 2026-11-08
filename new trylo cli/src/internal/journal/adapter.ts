import type { ExecutionFact } from "./projection.js";

export type CanonicalExecutionEvent = {
  readonly eventId: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly sequence?: number;
  readonly scope?: string;
  readonly taskFamily?: string;
  readonly snapshotId?: string;
  readonly assetVersions?: Readonly<Record<string, string>>;
  readonly outcome?: ExecutionFact["outcome"];
  readonly verdict?: ExecutionFact["verdict"];
  readonly latencyMs?: number;
  readonly tokenCost?: number;
  readonly causalRefs?: ReadonlyArray<string>;
  readonly rawBody?: string;
  readonly secret?: string;
  readonly reason?: string;
};

export function toExecutionFact(event: CanonicalExecutionEvent): ExecutionFact {
  const fact: ExecutionFact = {
    eventId: event.eventId,
    kind: event.kind,
    occurredAt: event.occurredAt,
  };
  return withCopiedWhitelist(fact, event);
}

// Copy approved fields explicitly so raw bodies and secrets stay outside learning facts.
function withCopiedWhitelist(
  fact: ExecutionFact,
  event: CanonicalExecutionEvent,
): ExecutionFact {
  let next = fact;

  if (event.sequence !== undefined) {
    next = { ...next, sequence: event.sequence };
  }

  if (event.scope !== undefined) {
    next = { ...next, scope: event.scope };
  }

  if (event.taskFamily !== undefined) {
    next = { ...next, taskFamily: event.taskFamily };
  }

  if (event.snapshotId !== undefined) {
    next = { ...next, snapshotId: event.snapshotId };
  }

  if (event.assetVersions !== undefined) {
    next = { ...next, assetVersions: event.assetVersions };
  }

  if (event.outcome !== undefined) {
    next = { ...next, outcome: event.outcome };
  }

  if (event.verdict !== undefined) {
    next = { ...next, verdict: event.verdict };
  }

  if (event.latencyMs !== undefined) {
    next = { ...next, latencyMs: event.latencyMs };
  }

  if (event.tokenCost !== undefined) {
    next = { ...next, tokenCost: event.tokenCost };
  }

  if (event.causalRefs !== undefined) {
    next = { ...next, causalRefs: event.causalRefs };
  }

  if (event.reason !== undefined) {
    next = { ...next, reason: event.reason };
  }

  return next;
}
