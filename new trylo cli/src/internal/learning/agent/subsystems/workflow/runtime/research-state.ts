import type { WorkflowImprovement } from "../improvement/contracts.js";
import type { WorkflowResearchObservation } from "../improvement/research-contracts.js";
import { parseWorkflowResearchFinding } from "../improvement/research-finding.js";
import { parseWorkflowImprovement } from "../improvement/parse.js";
import { record, text, workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";

export const WORKFLOW_RESEARCH_POLICY = "workflow:source-bound-internal-research:v2";

type CheckpointBase = {
  readonly type: "workflow_improvement_research"; readonly schemaVersion: 1;
  readonly scope: string; readonly inputVersionId: string; readonly grantId: string;
  readonly step: number; readonly reservationId: string; readonly contextRef: string;
  readonly previousVersionId?: string;
};

/** Confirmed domain work only, never a provider retry right or a second funds ledger. */
export type WorkflowResearchCheckpoint = CheckpointBase & (
  | { readonly status: "continue"; readonly observation: WorkflowResearchObservation }
  | { readonly status: "candidate"; readonly artifact: WorkflowImprovement }
  | { readonly status: "waiting_evidence" | "stopped"; readonly reason: string; readonly evidenceRefs: readonly string[] }
);

export type WorkflowResearchHead = { readonly versionId: string; readonly record: WorkflowResearchCheckpoint };

const refs = (value: unknown, maximum: number): value is string[] => Array.isArray(value) && value.length <= maximum
  && value.every(item => text(item) && item.length <= 4096) && new Set(value).size === value.length;
const boundedText = (value: unknown): value is string => text(value) && value.length <= 1500;
const invalid = () => workflowFailure("workflow_research_corrupt", "Invalid immutable workflow research checkpoint");

export function parseWorkflowResearchCheckpoint(value: unknown): WorkflowLearningResult<WorkflowResearchCheckpoint> {
  if (!record(value) || value.type !== "workflow_improvement_research" || value.schemaVersion !== 1
    || ![value.scope, value.inputVersionId, value.grantId, value.reservationId, value.contextRef].every(item => text(item) && item.length <= 512)
    || !Number.isSafeInteger(value.step) || typeof value.step !== "number" || value.step < 0
    || value.previousVersionId !== undefined && (!text(value.previousVersionId) || value.previousVersionId.length > 512)) return invalid();

  const base: CheckpointBase = { type: "workflow_improvement_research", schemaVersion: 1,
    scope: String(value.scope), inputVersionId: String(value.inputVersionId), grantId: String(value.grantId),
    step: value.step, reservationId: String(value.reservationId), contextRef: String(value.contextRef),
    ...(value.previousVersionId === undefined ? {} : { previousVersionId: value.previousVersionId }) };

  if (value.status === "candidate") {
    const artifact = parseWorkflowImprovement(value.artifact);
    return artifact.ok ? { ok: true, value: { ...base, status: "candidate", artifact: artifact.value } } : artifact;
  }

  if (value.status === "waiting_evidence" || value.status === "stopped") return boundedText(value.reason) && refs(value.evidenceRefs, 8)
    ? { ok: true, value: { ...base, status: value.status, reason: value.reason, evidenceRefs: value.evidenceRefs } } : invalid();

  if (value.status !== "continue" || !record(value.observation)) return invalid();

  const observation = value.observation;
  if (observation.kind === "finding_recorded") {
    const finding = parseWorkflowResearchFinding(observation.finding);
    return finding.ok ? { ok: true, value: { ...base, status: "continue", observation: { kind: "finding_recorded", finding: finding.value } } } : finding;
  }

  if (observation.kind === "material_read" && refs(observation.evidenceRefs, 8)) return { ok: true,
    value: { ...base, status: "continue", observation: { kind: "material_read", evidenceRefs: observation.evidenceRefs } } };

  if (observation.kind === "versions_compared" && refs(observation.versionIds, 4)) return { ok: true,
    value: { ...base, status: "continue", observation: { kind: "versions_compared", versionIds: observation.versionIds } } };

  if (observation.kind === "invalid_response" && boundedText(observation.code) && boundedText(observation.message)) return { ok: true,
    value: { ...base, status: "continue", observation: { kind: "invalid_response", code: observation.code, message: observation.message } } };

  return invalid();
}

/** Arrival order is immutable. Reject forks, gaps and renamed paid steps rather than guessing progress. */
export function workflowResearchChain(records: readonly WorkflowResearchHead[], inputVersionId: string, grantId: string): WorkflowLearningResult<readonly WorkflowResearchHead[]> {
  const chain = records.filter(item => item.record.inputVersionId === inputVersionId && item.record.grantId === grantId);
  let previous: WorkflowResearchHead | undefined;

  for (const item of chain) {
    if (item.record.step !== (previous?.record.step ?? -1) + 1 || item.record.previousVersionId !== previous?.versionId
      || previous !== undefined && previous.record.status !== "continue"
        && !(previous.record.status === "waiting_evidence" && previous.record.contextRef !== item.record.contextRef)) return invalid();
    previous = item;
  }

  return { ok: true, value: chain };
}

/** Keep recent public reasoning across material switches. Historical reads are
 * not evidence exposure in a changed context; findings remain labelled interpretations. */
export function boundWorkflowResearchObservations(observations: readonly WorkflowResearchObservation[]): readonly WorkflowResearchObservation[] {
  const findings = new Set(observations.flatMap((item, index) => item.kind === "finding_recorded" ? [index] : []).slice(-8));
  const navigation = new Set(observations.flatMap((item, index) => item.kind !== "finding_recorded" ? [index] : []).slice(-12));
  return observations.filter((_item, index) => findings.has(index) || navigation.has(index));
}

export function workflowResearchObservations(records: readonly WorkflowResearchHead[], contextRef: string): readonly WorkflowResearchObservation[] {
  return boundWorkflowResearchObservations(records.flatMap(item => item.record.status === "continue"
    && (item.record.contextRef === contextRef || item.record.observation.kind === "finding_recorded") ? [item.record.observation] : []));
}
