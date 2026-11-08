import type { CentralRuntimeExecutionPort, CentralRuntimeMaterial, CentralRuntimeWork, CentralRuntimeWorkResult } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { decideCentralLearningWithEvidence } from "../learning-allocation/evidence-decision.js";
import { readCentralPursuitObservations } from "../learning-allocation/pursuit-observations.js";
import { createLearningAllocationApplication } from "../learning-allocation/application.js";
import { inspectCentralFundedStage } from "./funded-stage.js";
import { readFrozenStage, retainFrozenStage } from "./stage-evidence.js";
import { refreshCentralQualifications } from "./qualification-refresh.js";
import { recordCentralStageObservation } from "./observations.js";
import { centralStageUnitId } from "./stage-unit.js";
import { readRuntimeAgentOriginalWork, runtimeAgentWork } from "./runtime-agent-execution-frame.js";
import { fundRuntimeAgentStage } from "./runtime-agent-execution-funding.js";
import { assertRuntimeAgentActive, prepareRuntimeAgentSource, readRuntimeAgentBoard, runtimeAgentIssue, runtimeAllowanceWithin, runtimeAgentCeiling,
  type CentralRuntimeAgentExecutionOptions } from "./runtime-agent-execution-prepare.js";
import type { CentralLearningExecutionPort } from "./contracts.js";
import type { CentralWorkflowExecution } from "./workflow.js";
import { isCentralLearningAllowance } from "../../learning/control/coordination-parse.js";
import { readCentralStageDispatchEvidence } from "./stage-dispatch-evidence.js";
import { CentralRuntimeBlocked } from "../../learning/central/runtime/errors.js";
import { runtimeAgentWait } from "./runtime-agent-execution-wait.js";

export type { CentralRuntimeAgentExecutionOptions } from "./runtime-agent-execution-prepare.js";

const unresolved = (reason: string, refs: readonly string[] = []): CentralRuntimeWorkResult => ({
  outcome: "unknown", publicResult: canonicalJson({ reason, goalCompletion: "unknown", economicGain: "unknown" }), resultRefs: refs });

type Recovery = Awaited<ReturnType<CentralRuntimeExecutionPort["recover"]>>;

function resultAfterDispatch(value: Recovery, reason: string, refs: readonly string[]): CentralRuntimeWorkResult {
  return value === null || "kind" in value ? unresolved(reason, refs) : value;
}

function hasWorkflowProgress(port: CentralLearningExecutionPort): port is CentralLearningExecutionPort & Pick<CentralWorkflowExecution, "readResearch"> {
  return port.domain === "workflow" && "readResearch" in port && typeof port.readResearch === "function";
}

/** The model keeps purpose and chooses the exact issue/operation. Numerical
 * advice is optional evidence; proposal qualification never becomes intent value. */
export function createCentralRuntimeAgentExecution(options: CentralRuntimeAgentExecutionOptions): CentralRuntimeExecutionPort {
  const readWork = async (work: CentralRuntimeWork) => {
    const decoded = await readRuntimeAgentOriginalWork(work, options.scope, options.boardRoot);
    const owner = decoded.input.offer.owner;
    const port = options.ports.find(row => owner.plane === "agent" && row.domain === owner.domain);
    if (port === undefined) throw new Error("central_runtime_agent_domain_unavailable");
    return { ...decoded, port };
  };
  const recoverKnown = async (work: CentralRuntimeWork, signal: AbortSignal): Promise<Recovery> => {
    const current = await readWork(work);
    const observation = await current.port.observe(current.input, signal);
    const receipt = current.port.domain === "workflow" || current.port.domain === "collaboration"
      ? await readCentralStageDispatchEvidence({ boardRoot: options.boardRoot, scope: options.scope, domain: current.port.domain }, current.input) : undefined;
    const progress = hasWorkflowProgress(current.port) ? await current.port.readResearch(current.input.issueId) : undefined;
    if (progress !== undefined && (progress.issueId !== current.input.issueId || progress.grantId !== current.input.grantId)) {
      throw new Error("central_runtime_agent_handback_owner_mismatch");
    }

    const refs = [...new Set([work.workRef, current.input.grantId, ...observation.resultRefs, ...observation.sourceRefs,
      ...(progress?.sourceRefs ?? [])])];
    const handback = { ...(progress === undefined ? {} : { workflowResearch: {
      interpretation: "current_original_owner_progress_not_frozen_stage_qualification", progress } }),
      ...(receipt?.status !== "ready" ? {} : { originalDispatchReceipt: receipt.dispatch }) };
    const board = await readRuntimeAgentBoard(options);
    const wait = runtimeAgentWait(board, current.input.grantId, receipt?.status === "ready" ? receipt.dispatch : undefined, progress);

    if (observation.outcome !== "pending" || receipt?.status === "ready") return {
      outcome: receipt?.status === "ready" && (!receipt.dispatch.ok || receipt.dispatch.status === "failed" || receipt.dispatch.status === "cancelled") ? "failed" : "returned", resultRefs: refs,
      ...(wait === undefined ? {} : { wait }),
      publicResult: canonicalJson({ stageRef: current.input.stageRef, observation, ...handback,
        interpretation: "original_proposal_criterion_not_learning_goal_or_economic_gain", goalCompletion: "unknown", economicGain: "unknown" }) };

    const grant = board.centralLearningGrants?.find(row => row.grantId === current.input.grantId);
    const job = board.jobs.find(row => row.jobId === grant?.jobId);
    const history = readCentralPursuitObservations(board, options.scope);
    if (history.status !== "ready") throw new Error(history.reason);

    const assigned = history.heads.some(row => row.unitId === centralStageUnitId(current.input.grantId, current.input.stageRef));
    const inspected = inspectCentralFundedStage(board, { scope: options.scope, domain: current.port.domain, input: current.input });

    // An untouched initial job plus the absent dispatch fence proves not sent.
    // Later attempts or a present fence are ambiguous and never get this result.
    if (!assigned && (receipt === undefined || receipt.status === "absent") && !signal.aborted && options.enabled() && inspected.ok && grant?.status === "open"
      && job?.state === "queued" && job.attempt === 0 && grant.claim === undefined && grant.reservations.length === 0) {
      return { kind: "ready_to_execute" };
    }

    if (grant?.claim !== undefined || job?.state === "running" || grant?.reservations.some(row => row.state === "reserved")) return null;

    return { outcome: "unknown", resultRefs: refs, ...(wait === undefined ? {} : { wait }), publicResult: canonicalJson({
      reason: "central_runtime_agent_original_receipt_unresolved_no_replay", ...handback, goalCompletion: "unknown", economicGain: "unknown" }) };
  };
  const recover = async (work: CentralRuntimeWork, signal: AbortSignal): Promise<Recovery> => {
    try { return await recoverKnown(work, signal); }
    catch { return unresolved("central_runtime_agent_recovery_evidence_unavailable", [work.workRef]); }
  };

  return {
    async consult(input): Promise<CentralRuntimeMaterial> {
      if (input.scope !== options.scope) throw new Error("central_runtime_agent_scope_mismatch");

      if (input.subject.plane === "central") {
        assertRuntimeAgentActive(options, input.signal);
        const board = await readRuntimeAgentBoard(options), root = board.centralLearningBudgets?.find(row => row.scope === options.scope);
        if (root === undefined) throw new Error("central_runtime_agent_budget_unavailable");

        runtimeAgentCeiling(options, board, options.rootAllowance);
        const decision = decideCentralLearningWithEvidence({ schemaVersion: 1, board, candidates: [], horizon: 1,
          basis: { scope: options.scope, boardSequence: board.sequence, budgetId: root.budgetId,
            utilityUnit: "qualified_objective_completions", valuationRef: input.subject.questionRef } });
        const body = { interpretation: "no_native_stage_to_price_not_a_stop_judgment_on_the_intent", selectedSubject: input.subject,
          requirement: "Choose a domain receiver for a real native stage before numerical stage consultation", decision };

        return { ref: `runtime-agent-advice:${contentHashOf(body)}`, kind: "numerical_advice", text: canonicalJson(body),
          sourceRefs: [root.budgetId, input.subject.questionRef] };
      }

      const prepared = await prepareRuntimeAgentSource(options, input.subject, input.allowance, options.rootAllowance, input.signal);
      const board = await readRuntimeAgentBoard(options), candidates = prepared.status === "ready" ? [prepared.selected.candidate] : [];
      const decision = decideCentralLearningWithEvidence({ schemaVersion: 1, board,
        basis: { ...prepared.basis, boardSequence: board.sequence }, candidates, horizon: 1,
        responseContexts: prepared.status !== "ready" || prepared.selected.stage.responseContext === undefined ? []
          : [{ opportunityId: prepared.selected.stage.offer.offerId, context: prepared.selected.stage.responseContext }] });
      const body = { selectedSubject: input.subject, incrementalAllowance: input.allowance,
        interpretation: "optional_original_numerical_advice_not_intent_value_or_authority", decision,
        unavailable: prepared.status === "ready" ? [] : prepared.unavailable };

      return { ref: `runtime-agent-advice:${contentHashOf(body)}`, kind: "numerical_advice", text: canonicalJson(body),
        sourceRefs: [prepared.basis.budgetId, ...(input.subject.plane === "agent" ? [input.subject.issueId] : [])] };
    },

    async prepare(input) {
      assertRuntimeAgentActive(options, input.signal);

      if (input.scope !== options.scope || input.configuration.authorizationRef !== options.authorizationRef) throw new Error("central_runtime_agent_authorization_mismatch");

      const loaded = await readRuntimeAgentBoard(options);
      const ceiling = runtimeAgentCeiling(options, loaded, input.configuration.allowance, input.configuration.rootRef);
      let subject = input.intent.subject;
      if (subject.plane === "agent" && input.operation.destination !== undefined
        && (input.operation.destination.plane !== "agent" || input.operation.destination.domain !== subject.domain)) {
        throw new CentralRuntimeBlocked("central_runtime_agent_destination_mismatch", [subject.issueId], "preparation");
      }

      if (subject.plane === "central") {
        const destination = input.operation.destination;
        const port = destination?.plane === "agent" ? options.ports.find(row => row.domain === destination.domain) : undefined;
        if (port?.acceptResearch === undefined) throw new CentralRuntimeBlocked("central_runtime_native_research_receiver_required",
          [input.intent.intentId], "preparation");

        const received = await port.acceptResearch({ intentRef: input.intent.intentId, intent: input.intent, operation: input.operation }, input.signal);
        if (received.status !== "accepted") throw new CentralRuntimeBlocked(received.reason, received.sourceRefs, "preparation");

        subject = { plane: "agent", domain: port.domain, issueId: received.issueId };
      }

      const sourceBoard = subject === input.intent.subject ? loaded : await readRuntimeAgentBoard(options);

      assertRuntimeAgentActive(options, input.signal);
      const issue = runtimeAgentIssue(options, sourceBoard, subject);
      if (!isCentralLearningAllowance(input.operation.allowance)
        || issue.grantId === undefined && !runtimeAllowanceWithin(input.operation.allowance, ceiling)) {
        throw new CentralRuntimeBlocked("central_runtime_agent_allowance_exceeds_authorization", [issue.issueId], "resources");
      }

      if (issue.decision.kind === "unreviewed") {
        const focused = await options.control.decide({ issueId: issue.issueId, expectedRevision: issue.revision,
          decision: "focused_learning", reason: `central-runtime-intent:${input.intent.intentId}`,
          sourceRefs: [...new Set([input.intent.intentId, ...input.intent.sourceRefs])].slice(0, 32) });
        if (!focused.ok) throw new Error(focused.reason);
      } else if (issue.decision.kind !== "focused_learning") throw new CentralRuntimeBlocked("central_runtime_agent_pa_decision_preserved", [issue.issueId], "preparation");

      const prepared = await prepareRuntimeAgentSource(options, subject, input.operation.allowance,
        input.configuration.allowance, input.signal, true, input.configuration.rootRef);
      if (prepared.status !== "ready") throw new CentralRuntimeBlocked(prepared.unavailable[0]?.reason ?? "central_runtime_agent_source_unavailable",
        prepared.unavailable.flatMap(row => row.sourceRefs), prepared.boundary);

      const operationKey = `central-runtime-intent-operation:${contentHashOf([input.intent.intentId, input.operation.operationId])}:`;
      const planRef = `${operationKey}${contentHashOf({ intent: input.intent, operation: input.operation,
        configurationRef: input.configuration.configurationRef, stage: prepared.selected.stage })}`;
      const selectedBoard = await readRuntimeAgentBoard(options);
      const priorPlan = selectedBoard.centralLearningGrants?.find(row => row.grantId === prepared.selected.stage.source.grantId)?.planRef;
      if (priorPlan?.startsWith(operationKey) && priorPlan !== planRef) throw new Error("central_runtime_agent_operation_plan_conflict");

      const original = await readFrozenStage({ boardRoot: options.boardRoot, scope: options.scope,
        grantId: prepared.selected.stage.source.grantId, stageRef: prepared.selected.stage.stageRef });
      if (original.status === "ready") {
        const board = await readRuntimeAgentBoard(options);
        const grant = board.centralLearningGrants?.find(row => row.grantId === original.value.input.grantId);
        if (grant?.planRef !== planRef || contentHashOf(original.value.input.offer) !== contentHashOf(prepared.selected.stage.offer)
          || contentHashOf(original.value.input.sourceContext ?? null) !== contentHashOf(prepared.selected.stage.sourceContext ?? null)) {
          throw new Error("central_runtime_agent_operation_plan_conflict");
        }

        return runtimeAgentWork({ intentId: input.intent.intentId, operation: input.operation, scope: options.scope,
          budgetId: original.value.budgetId, authorizationRef: input.configuration.authorizationRef,
          input: original.value.input, digest: original.value.digest });
      }

      if (original.reason !== "central_stage_archive_missing") throw new Error(original.reason);

      const funded = await fundRuntimeAgentStage(options, prepared.selected, prepared.basis.budgetId,
        planRef, input.configuration, input.signal);
      const retained = await retainFrozenStage({ boardRoot: options.boardRoot, candidate: prepared.selected.candidate, input: funded });
      if (retained.status !== "retained") throw new Error(retained.reason);

      return runtimeAgentWork({ intentId: input.intent.intentId, operation: input.operation, scope: options.scope,
        budgetId: prepared.basis.budgetId, authorizationRef: input.configuration.authorizationRef, input: funded, digest: retained.value.digest });
    },

    async execute(work, signal) {
      assertRuntimeAgentActive(options, signal);
      const current = await readWork(work), board = await readRuntimeAgentBoard(options);
      const prior = readCentralPursuitObservations(board, options.scope);
      if (prior.status !== "ready") throw new Error(prior.reason);

      if (prior.heads.some(row => row.unitId === centralStageUnitId(current.input.grantId, current.input.stageRef))) {
        return resultAfterDispatch(await recover(work, signal), "central_runtime_agent_original_worker_in_flight", [work.workRef]);
      }

      const inspected = inspectCentralFundedStage(board, { scope: options.scope, domain: current.port.domain, input: current.input });
      if (!inspected.ok) return unresolved(inspected.reason, [work.workRef]);

      // Only a confirmed first write may dispatch. A crash immediately after this
      // fence is ambiguous and deliberately never becomes an automatic replay.
      const assigned = await recordCentralStageObservation({ boardRoot: options.boardRoot, enabled: options.enabled,
        candidate: current.frozen.candidate, input: current.input, mode: "initial", observed: { outcome: "pending", resultRefs: [],
          sourceRefs: [current.input.sourceBindingRef, current.input.stageRef, current.input.grantId],
          reason: "funded_stage_outcome_unresolved_not_proof_of_execution" } });
      if (assigned.status !== "written" || assigned.idempotent) {
        return resultAfterDispatch(await recover(work, signal), "central_runtime_agent_dispatch_assignment_unconfirmed", [work.workRef]);
      }

      assertRuntimeAgentActive(options, signal);

      try {
        const dispatched = await current.port.dispatch(current.input, signal);

        // The original observer and revision owner qualify only its frozen
        // criterion. New requirements or poor later use do not erase delivery.
        await refreshCentralQualifications({ boardRoot: options.boardRoot, scope: options.scope, ports: [current.port],
          enabled: options.enabled, issueId: current.input.issueId }, signal);
        const after = await readRuntimeAgentBoard(options);
        const grant = after.centralLearningGrants?.find(row => row.grantId === current.input.grantId);
        if (dispatched.workAttempted && grant?.status === "open" && grant.claim === undefined
          && !grant.reservations.some(row => row.state === "reserved")) {
          const reconciled = await createLearningAllocationApplication(options).reconcile({ grantId: grant.grantId,
            expectedSequence: after.sequence, authorizationRef: current.authorizationRef });
          if (!("ok" in reconciled) || !reconciled.ok) return unresolved("central_runtime_agent_settlement_unconfirmed", [work.workRef, grant.grantId]);
        }

        const recovered = resultAfterDispatch(await recover(work, signal), "central_runtime_agent_original_worker_in_flight", [work.workRef]);
        const originalStageResult: unknown = JSON.parse(recovered.publicResult);

        return { ...recovered, publicResult: canonicalJson({ originalStageResult,
          originalDispatch: dispatched, goalCompletion: "unknown", economicGain: "unknown" }) };
      } catch {
        // Dispatch may already have claimed, paid or published. Preserve the
        // original pending/charges and allow read-only recovery, never retry.
        return unresolved("central_runtime_agent_dispatch_outcome_unknown", [work.workRef, current.input.grantId]);
      }
    },

    recover,
  };
}
