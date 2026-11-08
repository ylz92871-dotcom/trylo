import { withBoardWriter } from "../../../../../../adapters/learning-store/file-event-store.js";
import { checkerMatches } from "../../domain/v2/parse.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { textOf } from "../../../../../domains/tool/evolution/parse.js";
import type { BoardStore } from "../../../../../control/store-port.js";
import { CHECKER_RUNS_PER_TURN, type CheckerCatalog, type CheckerEngineOptions, type CheckerFailure,
  type CheckerOutcome, type CheckerRun, type CheckerRunClaim } from "./contracts.js";
import { appendCheckerRecord, decodeCheckerCatalog, failure, readCheckerBoard } from "../../adapters/board/store.js";
import { parseCheckerRunOutcome, parseCheckerRunRequest, runRequest, sameRunRequest, type CheckerRunRequest } from "./run-identity.js";

export type CheckerRunReservation = { readonly ok: true; readonly claimed: true; readonly claim: CheckerRunClaim }
  | { readonly ok: true; readonly claimed: false; readonly previous?: CheckerRun;
    readonly reason: "completed" | "waiting" | "turn_budget_exhausted" | "outcome_unknown" | "not_applicable" };

export type ClaimedCheckerResult = { readonly ok: true; readonly claimed: boolean; readonly run?: CheckerRun; readonly reason?: string } | CheckerFailure;

type OwnerState = "alive" | "dead" | "unknown";

/** Claim and quota are persisted together before the executor can see the input. */
export async function reserveCheckerRun(options: CheckerEngineOptions, raw: CheckerRunRequest): Promise<CheckerRunReservation | CheckerFailure> {
  const parsed = parseCheckerRunRequest(raw);
  if (!parsed.ok) return parsed;

  if (!textOf(options.owner.id, 512)) return failure("checker_owner_invalid", "checker execution needs a bounded owner identity");

  const request = parsed.value;
  const snapshot = await readCheckerBoard(options.boardRoot);
  if (!snapshot.ok) return snapshot;

  const previous = snapshot.catalog.runs.find(run => run.runId === request.runId);
  if (previous !== undefined) return previousReservation(previous, request);

  const observed = snapshot.catalog.runClaims.find(claim => claim.runId === request.runId);
  const liveness = observed === undefined ? "unknown" : await ownerState(options, observed.ownerId);
  const result = await withBoardWriter(options.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return failure(loaded.reason, loaded.detail);

    const decoded = decodeCheckerCatalog(loaded.state);
    if (!decoded.ok) return decoded;

    const terminal = decoded.catalog.runs.find(run => run.runId === request.runId);
    if (terminal !== undefined) return previousReservation(terminal, request);

    const existing = decoded.catalog.runClaims.find(claim => claim.runId === request.runId);
    if (existing !== undefined) {
      if (!sameRunRequest(existing, request)) return failure("checker_run_identity_conflict", "one run identity cannot check another input or version");

      if (observed === undefined || contentHashOf(observed) !== contentHashOf(existing) || liveness !== "dead") {
        return { ok: true as const, claimed: false as const, reason: "waiting" as const };
      }

      const recovered = unknownRun(existing);
      const saved = await appendCheckerRecord(store, recovered, new Date(options.now()).toISOString());

      return saved.ok ? { ok: true as const, claimed: false as const, reason: "outcome_unknown" as const, previous: recovered } : saved;
    }

    return claimFreshRun(store, options, request, decoded.catalog);
  });

  return "reason" in result && !result.ok ? failure(result.reason, result.detail) : result;
}

/** Completion replay never spends quota again; cancellation after claim consumes that reservation. */
export async function runClaimedChecker(options: CheckerEngineOptions, request: CheckerRunRequest,
  execute: () => Promise<CheckerOutcome>, signal?: AbortSignal): Promise<ClaimedCheckerResult> {
  if (options.collection() === "disabled") return { ok: true, claimed: false, reason: "collection_disabled" };

  if (signal?.aborted) return { ok: true, claimed: false, reason: "cancelled" };

  const reservation = await reserveCheckerRun(options, request);
  if (!reservation.ok) return reservation;

  if (!reservation.claimed) return { ok: true, claimed: false, reason: reservation.reason,
    ...(reservation.previous === undefined ? {} : { run: reservation.previous }) };

  let outcome: CheckerOutcome;

  try {
    outcome = signal?.aborted || options.collection() === "disabled" ? { kind: "cancelled" }
      : parseCheckerRunOutcome(await execute(), request.requirements.ref) ?? { kind: "checker_error", code: "invalid_verdict" };
    if (signal?.aborted || options.collection() === "disabled") outcome = { kind: "cancelled" };
  } catch {
    // The executor may have started. Preserve a terminal fault and the consumed claim; never infer an object violation.
    outcome = signal?.aborted ? { kind: "cancelled" } : { kind: "checker_error", code: "executor_threw" };
  }

  const run: CheckerRun = { schemaVersion: 2, type: "checker_run", ...runRequest(reservation.claim), outcome };

  return settleClaimedRun(options, reservation.claim, run);
}

/** A positively dead owner is closed as unknown. A restart never re-executes its claimed check. */
export async function recoverCheckerRuns(options: CheckerEngineOptions) {
  const snapshot = await readCheckerBoard(options.boardRoot);
  if (!snapshot.ok) return snapshot;

  const recovered: string[] = [];

  for (const claim of snapshot.catalog.runClaims) {
    if (snapshot.catalog.runs.some(run => run.runId === claim.runId) || await ownerState(options, claim.ownerId) !== "dead") continue;
    const result = await reserveCheckerRun(options, runRequest(claim));
    if (!result.ok) return result;
    if (!result.claimed && result.reason === "outcome_unknown") recovered.push(claim.runId);
  }

  return { ok: true as const, recovered };
}

async function claimFreshRun(store: BoardStore, options: CheckerEngineOptions, request: CheckerRunRequest, catalog: CheckerCatalog) {
  const version = catalog.versions.find(entry => entry.versionId === request.versionId);
  if (version === undefined || version.value.requirements.ref !== request.requirements.ref
    || version.value.requirements.digest !== request.requirements.digest || version.value.checker.applicability.scope !== request.scope) {
    return failure("checker_run_version_unbound", "run must name a version for this exact scope and requirement");
  }

  if (!checkerMatches(version.value.checker, request.input, request.scope)) return { ok: true as const, claimed: false as const, reason: "not_applicable" as const };

  const turnClaims = catalog.runClaims.filter(claim => claim.scope === request.scope && claim.sessionId === request.sessionId && claim.turnId === request.turnId);
  if (turnClaims.length >= CHECKER_RUNS_PER_TURN) return { ok: true as const, claimed: false as const, reason: "turn_budget_exhausted" as const };

  const claim: CheckerRunClaim = { schemaVersion: 2, type: "checker_run_claim", ...request, ownerId: options.owner.id };
  const saved = await appendCheckerRecord(store, claim, new Date(options.now()).toISOString());

  return saved.ok ? { ok: true as const, claimed: true as const, claim } : saved;
}

async function settleClaimedRun(options: CheckerEngineOptions, claim: CheckerRunClaim, run: CheckerRun): Promise<ClaimedCheckerResult> {
  const result = await withBoardWriter(options.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return failure(loaded.reason, loaded.detail);

    const decoded = decodeCheckerCatalog(loaded.state);
    if (!decoded.ok) return decoded;

    const current = decoded.catalog.runClaims.find(item => item.runId === claim.runId);
    if (current === undefined || contentHashOf(current) !== contentHashOf(claim) || current.ownerId !== options.owner.id) {
      return failure("checker_run_claim_lost", "execution no longer owns this exact durable claim");
    }

    const terminal = decoded.catalog.runs.find(item => item.runId === claim.runId);
    if (terminal !== undefined) return sameRunRequest(terminal, run)
      ? { ok: true as const, claimed: false, run: terminal, reason: "completed_before_settle" }
      : failure("checker_run_identity_conflict", "terminal run does not match its original reservation");

    const saved = await appendCheckerRecord(store, run, new Date(options.now()).toISOString());

    return saved.ok ? { ok: true as const, claimed: true, run } : saved;
  });
  return "reason" in result && !result.ok ? failure(result.reason, result.detail) : result;
}

function previousReservation(previous: CheckerRun, request: CheckerRunRequest): CheckerRunReservation | CheckerFailure {
  return sameRunRequest(previous, request) ? { ok: true, claimed: false, previous, reason: "completed" }
    : failure("checker_run_identity_conflict", "a completed run cannot be replayed for another input or version");
}

function unknownRun(claim: CheckerRunClaim): CheckerRun {
  return { schemaVersion: 2, type: "checker_run", ...runRequest(claim), outcome: { kind: "checker_error", code: "outcome_unknown" } };
}

async function ownerState(options: CheckerEngineOptions, ownerId: string): Promise<OwnerState> {
  try { return await options.owner.alive(ownerId); }
  catch { return "unknown"; } // An unavailable liveness probe cannot prove worker death.
}
