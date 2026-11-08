import type { Envelope } from "../../../../../protocol/envelope.js";
import type { WorkflowTrace } from "../domain/trace-contracts.js";

const BUDGET_CAUSES = new Set(["iterations_exhausted", "output_tokens_exhausted", "budget_usd_exhausted", "context_limit"]);

/** Projection of existing execution facts, with event idempotency across replay.
 * It owns no timers, cancellation, retries or execution lifecycle transitions. */
export function createWorkflowAccounting() {
  const seen = new Map<string, string>();
  const bounds = new Map<string, { first: number; last: number }>();
  let runState: NonNullable<WorkflowTrace["runState"]> = "running";
  let tokens = 0;
  let outputTokens = 0;
  let inputTokens = 0;
  let iterations = 0;
  const requests = new Map<string, { reported: boolean; finished: boolean }>();
  const usageSnapshots = new Map<string, { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number }>();
  let currentRequest: string | undefined;
  let lastTurn: string | undefined;

  function observe(event: Envelope): boolean {
    const key = JSON.stringify([event.sessionId, event.turnId, event.producerId, event.eventId]);
    const digest = JSON.stringify(event);
    const old = seen.get(key);
    if (old !== undefined) {
      if (old !== digest) throw new Error("workflow_history_conflict: event id was redelivered with changed facts");
      return false;
    }

    seen.set(key, digest);
    const turn = event.turnId ?? "";
    if (lastTurn !== turn) {
      lastTurn = turn;
      currentRequest = undefined;
      runState = "running";
    }

    const at = Date.parse(event.timestamp);
    if (Number.isFinite(at)) {
      const existing = bounds.get(turn);
      bounds.set(turn, existing === undefined ? { first: at, last: at } : { first: Math.min(existing.first, at), last: Math.max(existing.last, at) });
    }

    if (event.kind === "api_call") {
      iterations += 1;
      currentRequest = key;
      requests.set(key, { reported: false, finished: false });
    }

    if (event.kind === "usage") {
      const request = currentRequest === undefined ? undefined : requests.get(currentRequest);
      if (request !== undefined) request.reported = true;

      // Loop usage envelopes are merged snapshots for the current provider
      // request, including the final emission. Different event IDs do not
      // turn repeated snapshots into independent charges.
      const scope = currentRequest ?? `legacy-turn:${turn}`;
      const prior = usageSnapshots.get(scope) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const next = { inputTokens: finite(event.payload.inputTokens), outputTokens: finite(event.payload.outputTokens), totalTokens: finite(event.payload.totalTokens) };

      inputTokens += next.inputTokens - prior.inputTokens;
      outputTokens += next.outputTokens - prior.outputTokens;
      tokens += next.totalTokens - prior.totalTokens;
      usageSnapshots.set(scope, next);
    }

    if (event.kind === "stream_end") {
      const request = currentRequest === undefined ? undefined : requests.get(currentRequest);
      if (request !== undefined) request.finished = true;
    }

    if (event.kind === "terminal") {
      const reason = event.payload.reason;
      const cause = String(event.payload.cause ?? "");
      runState = reason === "cancelled" ? "cancelled" : reason === "completed" ? "completed"
        : BUDGET_CAUSES.has(cause) ? "budget_exhausted" : event.payload.awaitingContinuation === true ? "waiting"
        : reason === "failed" ? "failed" : "interrupted";
    }

    return true;
  }

  function snapshot() {
    const unknownRequestIds = [...requests].filter(([, request]) => !request.reported || !request.finished).map(([id]) => id);
    return { runState, tokens, outputTokens, inputTokens, iterations, usageUncertain: unknownRequestIds.length > 0, unknownRequestIds,
      wallMs: [...bounds.values()].reduce((sum, value) => sum + value.last - value.first, 0) };
  }

  return { observe, snapshot, interrupted() { if (runState === "running") runState = "interrupted"; } };
}

function finite(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
