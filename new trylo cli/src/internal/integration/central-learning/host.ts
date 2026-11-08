import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { decideCentralLearningWithEvidence } from "../learning-allocation/evidence-decision.js";
import { readCentralPursuitObservations } from "../learning-allocation/pursuit-observations.js";
import type { FocusedLearningDecision, FocusedLearningDispatch } from "../../learning/control/focused-learning-port.js";
import type { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { ensureCentralLearningBudget } from "./budget.js";
import type { CentralBudgetOptions } from "./budget.js";
import { prepareCentralCandidates } from "./candidates.js";
import { dispatchCentralDecision } from "./dispatch.js";
import { recordCentralStageObservation } from "./observations.js";
import { centralActionReceipt } from "./action-receipt.js";
import { refreshCentralQualifications } from "./qualification-refresh.js";
import type { CentralLearningExecutionPort } from "./contracts.js";
import type { CentralLearningEvidenceResult } from "../learning-allocation/evidence-decision-contract.js";

export type CentralLearningHostOptions = CentralBudgetOptions & {
  readonly ports: readonly CentralLearningExecutionPort[];
  readonly control: Pick<ReturnType<typeof createCollaborationControl>, "decide">;
  readonly onlyIssueId?: string;
  readonly admit?: Parameters<typeof prepareCentralCandidates>[0]["admit"];
};

export type CentralLearningRunResult = (Awaited<ReturnType<typeof dispatchCentralDecision>>
  | { readonly status: "cancelled" }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "reconcile_unconfirmed"; readonly reconciled: unknown;
      readonly decision: Extract<CentralLearningEvidenceResult, { status: "decided" }> }
  | { readonly status: "investment_ended" | "close_unconfirmed"; readonly closed: unknown;
      readonly decision: Extract<CentralLearningEvidenceResult, { status: "decided" }> }
  | { readonly status: "waiting_content"; readonly contentRequests: readonly unknown[];
      readonly admissions: readonly unknown[]; readonly decisionResult: unknown })
  & { readonly unavailable?: readonly { issueId: string; reason: string; sourceRefs: readonly string[] }[];
      readonly recorded?: unknown; readonly settlement?: unknown; readonly contentRequests?: readonly unknown[];
      readonly decision?: Extract<CentralLearningEvidenceResult, { status: "decided" }> };

/** Bounded orchestration at existing PA/task boundaries. The factory starts no
 * timer, model, worker, polling loop or alternative writer. */
export function createCentralLearningHost(options: CentralLearningHostOptions) {
  const read = () => createBoardReader(options.boardRoot).load();
  const refresh = (signal: AbortSignal, issueId?: string) => refreshCentralQualifications({
    boardRoot: options.boardRoot, scope: options.scope, ports: options.ports, enabled: options.enabled,
    ...(options.onlyIssueId === undefined && issueId === undefined ? {} : { issueId: options.onlyIssueId ?? issueId! }) }, signal);
  const nominate = async (signal: AbortSignal) => {
    // Explicit source actions already nominated their selected canonical issue.
    // They cannot enlist unrelated sources or turn their own coordination task
    // into a new learning opportunity.
    if (options.onlyIssueId !== undefined) return [];

    const issueIds: string[] = [];

    for (const port of options.ports) {
      if (signal.aborted || !options.enabled()) break;
      issueIds.push(...(await port.nominate?.(signal) ?? []));
    }

    return [...new Set(issueIds)];
  };
  const inspect = async () => {
    if (!options.enabled()) return { ok: false as const, reason: "collect_disabled" };

    const ready = await ensureCentralLearningBudget(options);
    if (!ready.ok) return ready;

    const observations = readCentralPursuitObservations(ready.board, options.scope);

    return { ok: true as const, boardSequence: ready.board.sequence, budget: ready.projection,
      domains: options.ports.map(port => port.domain), observations,
      dispatchBoundary: "explicit_PA_focus_or_resume" as const };
  };
  const focusIssue = async (input: FocusedLearningDecision, signal: AbortSignal) => {
    if (!options.enabled() || signal.aborted) return { ok: false as const, reason: "learning_aborted" };
    return options.control.decide({ ...input, decision: "focused_learning" });
  };
  const run = async (signal: AbortSignal, focusIssueId?: string,
    phase: "current" | "after_reconcile" | "after_close" = "current"): Promise<CentralLearningRunResult> => {
    if (!options.enabled() || signal.aborted) return { status: "cancelled" as const };

    await refresh(signal, focusIssueId);
    const ready = await ensureCentralLearningBudget(options);
    if (!ready.ok) return { status: "rejected" as const, reason: ready.reason };

    const preliminaryBasis = { scope: options.scope, budgetId: ready.projection.budget.budgetId,
      boardSequence: ready.board.sequence, utilityUnit: "qualified_objective_completions", valuationRef: "central-runtime:preparation-v1" };
    const sourceBoard = options.onlyIssueId === undefined ? ready.board : { ...ready.board,
      learningIssues: ready.board.learningIssues?.filter(issue => issue.issueId === options.onlyIssueId) ?? [] };
    const preparation = await prepareCentralCandidates({ board: sourceBoard, scope: options.scope,
      ...(focusIssueId === undefined ? {} : { focusIssueId }), ports: options.ports, allowance: options.allowance,
      ...(options.admit === undefined ? {} : { admit: options.admit }),
      nowMs: Date.parse(options.now()), basis: preliminaryBasis }, signal);

    if (signal.aborted || !options.enabled()) return { status: "cancelled" as const };

    // Original domain source preparation may append a report. Every numerical
    // computation uses the actual new prefix, not an edited old decision basis.
    const loaded = await read();
    if (!loaded.ok) return { status: "rejected" as const, reason: loaded.reason };

    const observations = readCentralPursuitObservations(loaded.state, options.scope);
    if (observations.status !== "ready") return { status: "rejected" as const, reason: observations.reason };

    const candidates = preparation.prepared.map(row => row.candidate);
    const basis = { ...preliminaryBasis, boardSequence: loaded.state.sequence,
      valuationRef: `central-runtime:${contentHashOf({ candidates, observations: observations.sourceRef })}` };
    const decision = decideCentralLearningWithEvidence({ schemaVersion: 1, board: loaded.state, basis,
      candidates, horizon: Math.min(8, Math.max(1, candidates.length)), responseContexts: preparation.prepared.flatMap(row =>
        row.stage.responseContext === undefined ? [] : [{ opportunityId: row.stage.offer.offerId, context: row.stage.responseContext }]) });
    if (decision.status !== "decided") return { status: "rejected" as const, reason: decision.reason, unavailable: preparation.unavailable };

    if (decision.nextStep.kind === "reconcile_then_replan" && phase === "current") {
      const grantId = decision.nextStep.evaluation.stage.grantId;
      const reconciled = await ready.application.reconcile({ grantId, expectedSequence: loaded.state.sequence,
        authorizationRef: options.authorizationRef });
      if (!("ok" in reconciled) || !reconciled.ok) return { status: "reconcile_unconfirmed" as const,
        reconciled: centralActionReceipt(reconciled), decision };
      return run(signal, focusIssueId, "after_reconcile");
    }

    if (decision.nextStep.kind === "end_investment") {
      const closed = await ready.application.closeInvestment({ grantId: decision.nextStep.evaluation.stage.grantId,
        expectedSequence: loaded.state.sequence, authorizationRef: options.authorizationRef,
        reason: decision.nextStep.reason, planRef: decision.decisionRef });
      if (!("ok" in closed) || !closed.ok) return { status: "close_unconfirmed", closed: centralActionReceipt(closed), decision };

      // Release is a confirmed canonical action. Only the fresh Board may expose
      // those resources to another actual stage; never assume a refund in-place.
      return phase === "current" ? run(signal, focusIssueId, "after_close")
        : { status: "investment_ended", closed: centralActionReceipt(closed), decision };
    }

    const result = await dispatchCentralDecision({ boardRoot: options.boardRoot, authorizationRef: options.authorizationRef,
      application: ready.application, enabled: options.enabled, prepared: preparation.prepared, decision }, signal);
    if (result.status !== "dispatched") return { ...result, decision, unavailable: preparation.unavailable };

    const recorded = await recordCentralStageObservation({ boardRoot: options.boardRoot, enabled: options.enabled,
      candidate: result.candidate, input: result.input, observed: result.observation });
    const after = await read();
    if (!after.ok) return { ...result, decision, recorded, unavailable: preparation.unavailable,
      settlement: { status: "unconfirmed", reason: after.reason } };

    const grant = after.state.centralLearningGrants?.find(row => row.grantId === result.input.grantId);
    // A dispatch receipt never implies a refund. The original writer permits
    // reduction only at a confirmed reservation/claim boundary and retains all
    // measured or conservatively unknown charges. The investment may continue
    // later through a fresh centrally authorized extension of this same grant.
    // A confirmed pre-claim refusal is still an unexecuted initial stage. Keep
    // its existing commitment for an explicit retry rather than manufacture a
    // zero-cap continuation. An uncertain invocation likewise cannot authorize
    // a refund. The original PA can still explicitly end that investment.
    const settlement = grant?.status !== "open" ? { status: "already_terminal" }
      : result.result.workAttempted !== true ? { status: "retained", reason: "worker_attempt_not_confirmed" }
        : centralActionReceipt(await ready.application.reconcile({ grantId: grant.grantId,
          expectedSequence: after.state.sequence, authorizationRef: options.authorizationRef }));

    return { ...result, decision, recorded, settlement, unavailable: preparation.unavailable };
  };
  const resume = async (signal: AbortSignal): Promise<FocusedLearningDispatch> => reply(await run(signal));

  return { inspect, nominate, refresh, focusIssue, run, resume };
}

/** Preserve the detailed central response in the normal tool result without
 * changing the canonical worker receipt or claiming work when none ran. */
export function reply(central: CentralLearningRunResult): FocusedLearningDispatch & { readonly central: unknown } {
  if (central.status === "dispatched") return { ...central.result, central };
  return central.status === "rejected" ? { ok: false, reason: central.reason, central }
    : central.status === "cancelled" ? { ok: false, reason: "learning_aborted", central }
      : { ok: true, status: central.status === "wait" || central.status === "defer" || central.status === "waiting_content"
        ? "waiting_dependency" : "idle", central };
}
