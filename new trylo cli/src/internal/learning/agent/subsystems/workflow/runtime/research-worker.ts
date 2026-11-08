import { contentHashOf } from "../../../../control/hash.js";
import { workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import type { WorkflowImprovementModelInput, WorkflowImprovementModelPort } from "../improvement/contracts.js";
import type { WorkflowResearchObservation } from "../improvement/research-contracts.js";
import { buildWorkflowCandidate } from "./improvement-candidate.js";
import type { WorkflowImprovementRuntimeOptions, WorkflowImprovementOpportunityRecord, WorkflowImprovementFunding, WorkflowImprovementReservation } from "./improvement-contracts.js";
import { prepareWorkflowImprovement } from "./improvement-preparation.js";
import { boundWorkflowResearchObservations, workflowResearchObservations, workflowResearchChain, type WorkflowResearchCheckpoint } from "./research-state.js";

export type WorkflowResearchWorkResult = { readonly versionId: string }
  | { readonly status: "yielded" | "waiting_evidence" | "stopped"; readonly reason: string; readonly checkpointRef?: string };

const stepId = (step: number) => `wf-research:${step}`;
const repairable = (code: string) => code === "learning_invalid_json" || code === "improvement_evidence_unexposed"
  || code === "learning_incomplete"
  || code.startsWith("invalid_") || code.startsWith("improvement_");

/** Domain-owned research. Only confirmed responses advance the immutable cursor;
 * provider uncertainty is returned to the owner without another sampling attempt. */
export async function workWorkflowResearch(options: WorkflowImprovementRuntimeOptions,
  funded: WorkflowImprovementFunding, record: WorkflowImprovementOpportunityRecord,
  model: WorkflowImprovementModelPort, signal: AbortSignal): Promise<WorkflowLearningResult<WorkflowResearchWorkResult>> {
  const funding = options.funding.research, save = options.store.saveResearch, decide = model.research;
  if (funding === undefined || save === undefined || decide === undefined || model.researchUsage === undefined) {
    return workflowFailure("workflow_research_unavailable", "The original research, checkpoint and funding ports are required");
  }

  const prepared = await prepareWorkflowImprovement(options, record);
  if (!prepared.ok) return prepared;

  const { parent, evidence, history, feedback, view } = prepared.value;
  const context: WorkflowImprovementModelInput = { opportunity: record.opportunity, evidence, history, feedback,
    ...(parent === undefined ? {} : { parent: parent.artifact }),
    ...(options.centralContent === undefined ? {} : { centralContent: options.centralContent }) };
  if (!(options.contextPublicData ?? options.publicData)(context)) return workflowFailure("workflow_private_report", "Research material must cross the original public-data boundary");

  const contextRef = `workflow-research-context:${contentHashOf(context)}`;
  const chain = workflowResearchChain(view.research ?? [], funded.inputVersionId, funded.grantId);
  if (!chain.ok) return chain;

  let head = chain.value.at(-1), lastReservation: WorkflowImprovementReservation | undefined;
  const confirmedSteps = new Set(chain.value.map(item => stepId(item.record.step)));
  // Prior-context reads stay in the immutable history but cannot attest that a
  // bounded new source view still contains their bodies or versions.
  const observations: WorkflowResearchObservation[] = [...workflowResearchObservations(chain.value, contextRef)];
  const handBack = async (status: "yielded" | "waiting_evidence" | "stopped", reason: string): Promise<WorkflowLearningResult<WorkflowResearchWorkResult>> => {
    const state = await funding.inspect(funded);
    if (!state.ok) return state;

    if (state.value.state === "running" || status === "stopped") {
      const claimed = await funding.claim(funded);
      if (!claimed.ok) return claimed;
      const reservation = { ...claimed.value, reservationId: lastReservation?.reservationId ?? head?.record.reservationId ?? "local-handoff",
        maxTokens: lastReservation?.maxTokens ?? 0 };
      const result = status === "stopped" ? { kind: "completed" as const, resultRefs: head === undefined ? [] : [head.versionId] }
        : { kind: "yielded" as const, reason };
      const released = await options.funding.finish(reservation, result);
      if (!released.ok) return released;
    }

    return { ok: true, value: { status, reason, ...(head === undefined ? {} : { checkpointRef: head.versionId }) } };
  };
  const publish = async (checkpoint: Extract<WorkflowResearchCheckpoint, { status: "candidate" }>) => {
    const claimed = await funding.claim(funded);
    if (!claimed.ok) return claimed;
    // The reservation is the real original paid step. A local reclaim changes
    // publication ownership, never its token history or model retry identity.
    const result = await options.store.publish(checkpoint.artifact, new Date(options.now()).toISOString(), {
      reservation: { ...claimed.value, reservationId: checkpoint.reservationId, maxTokens: 0 }, signal, now: options.now });
    return result.ok ? result : handBack("yielded", result.code);
  };

  if (head?.record.status === "candidate") return publish(head.record);

  if (head?.record.status === "stopped") return handBack("stopped", head.record.reason);

  if (head?.record.status === "waiting_evidence") {
    if (head.record.contextRef === contextRef) return handBack("waiting_evidence", head.record.reason);
    observations.push({ kind: "invalid_response", code: "external_material_changed", message: head.record.reason });
  }

  // Real remaining grant resources bound computation. A bounded working set is
  // not a permanent arbitrary step-count limit on this original purpose.
  for (let step = (head?.record.step ?? -1) + 1; Number.isSafeInteger(step); step++) {
    if (signal.aborted) return handBack("yielded", "workflow_research_cancelled");

    const inspected = await funding.inspect(funded);
    if (!inspected.ok) return inspected;

    // A sent step without a confirmed checkpoint cannot be guessed, even when
    // its usage is later known. Inspection must resolve that exact original step.
    if (inspected.value.unknownStepIds.length > 0 || inspected.value.attemptedStepIds.some(id => !confirmedSteps.has(id))) {
      return handBack("waiting_evidence", "workflow_research_sent_step_requires_inspection");
    }

    if (inspected.value.attemptedStepIds.includes(stepId(step))) return handBack("waiting_evidence", "workflow_research_checkpoint_missing");

    if (inspected.value.remaining.calls < 1 || inspected.value.remaining.steps < 1 || inspected.value.remaining.tokens < 2048) {
      return handBack("yielded", "workflow_research_budget_boundary");
    }

    const reserved = await funding.reserve(funded, { stepId: stepId(step), maxTokens: inspected.value.remaining.tokens });
    if (!reserved.ok) return reserved;

    lastReservation = reserved.value;
    let result: Awaited<ReturnType<NonNullable<WorkflowImprovementModelPort["research"]>>>;

    try { result = await decide({ ...context, observations: boundWorkflowResearchObservations(observations) }, signal, reserved.value.maxTokens); }
    catch { result = workflowFailure("workflow_worker_unavailable", "The research model did not return a confirmed action"); }

    const usage = model.researchUsage();
    const known = !usage.uncertain && usage.calls <= 1;
    const settled = await options.funding.settle(reserved.value, known
      ? { kind: "reported", totalTokens: usage.tokens } : { kind: "unknown", reason: "workflow_research_usage_incomplete" });
    if (!settled.ok) return settled;

    if (!known || signal.aborted) return handBack("waiting_evidence", "workflow_research_sent_step_requires_inspection");

    if (usage.tokens > reserved.value.maxTokens) return workflowFailure("learning_budget_exhausted", "Research exceeded its exact reservation");

    const base = { type: "workflow_improvement_research" as const, schemaVersion: 1 as const, scope: options.scope,
      inputVersionId: funded.inputVersionId, grantId: funded.grantId, step, reservationId: reserved.value.reservationId,
      contextRef, ...(head === undefined ? {} : { previousVersionId: head.versionId }) };
    let checkpoint: WorkflowResearchCheckpoint;

    if (!result.ok) {
      if (!repairable(result.code) && usage.calls !== 0) return handBack("yielded", result.code);
      checkpoint = { ...base, status: "continue", observation: { kind: "invalid_response", code: result.code, message: result.message.slice(0, 1500) } };
    } else {
      if (!options.publicData(result.value)) return handBack("yielded", "workflow_private_report");

      const action = result.value;
      if (action.kind === "read_material" || action.kind === "compare_versions") {
        const available = action.kind === "read_material" ? action.evidenceRefs.every(ref => evidence.some(item => item.ref === ref))
          : action.versionIds.every(id => history.some(item => item.versionId === id));
        const observation: WorkflowResearchObservation = !available
          ? { kind: "invalid_response", code: "workflow_research_material_unavailable", message: "Choose references from the supplied original-source index; unrelated or unavailable material cannot be read." }
          : action.kind === "read_material" ? { kind: "material_read", evidenceRefs: action.evidenceRefs }
            : { kind: "versions_compared", versionIds: action.versionIds };

        checkpoint = { ...base, status: "continue", observation };
      } else if (action.kind === "record_finding") {
        const read = [...observations].reverse().find(item => item.kind === "material_read")?.evidenceRefs ?? [];
        const compared = [...observations].reverse().find(item => item.kind === "versions_compared")?.versionIds ?? [];
        checkpoint = action.finding.sourceRefs.every(ref => read.includes(ref) || compared.includes(ref))
          ? { ...base, status: "continue", observation: { kind: "finding_recorded", finding: action.finding } }
          : { ...base, status: "continue", observation: { kind: "invalid_response", code: "workflow_finding_source_unexposed",
            message: "Public interpretations need the original material actually read in this context, not an old finding or a directory ref." } };
      } else if (action.kind === "propose") {
        const built = buildWorkflowCandidate({ opportunity: record.opportunity, evidence, proposal: action.proposal, history,
          ...(parent === undefined ? {} : { parent: parent.artifact, parentVersionId: parent.versionId }) }, view.versions);
        checkpoint = !built.ok ? { ...base, status: "continue", observation: { kind: "invalid_response",
          code: built.code, message: built.message.slice(0, 1500) } }
          : { ...base, status: "candidate", artifact: built.value };
      } else {
        const refs = action.kind === "wait_for_evidence" ? action.evidenceRefs : [];
        if (refs.some(ref => !evidence.some(item => item.ref === ref))) return handBack("yielded", "workflow_research_material_unavailable");
        checkpoint = { ...base, status: action.kind === "stop" ? "stopped" : "waiting_evidence", reason: action.reason, evidenceRefs: refs };
      }
    }

    const saved = await save(checkpoint, { reservation: reserved.value, signal, now: options.now });
    if (!saved.ok) return saved;

    head = { versionId: saved.value.versionId, record: checkpoint };
    confirmedSteps.add(stepId(step));

    if (usage.calls === 0) return handBack("yielded", result.ok ? "workflow_research_no_provider_call" : result.code);

    if (checkpoint.status === "candidate") return publish(checkpoint);

    if (checkpoint.status === "waiting_evidence" || checkpoint.status === "stopped") return handBack(checkpoint.status, checkpoint.reason);

    if (checkpoint.status === "continue") observations.push(checkpoint.observation);
  }

  return handBack("yielded", "workflow_research_step_capacity");
}
