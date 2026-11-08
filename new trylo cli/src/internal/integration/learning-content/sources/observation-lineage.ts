import type { BoardState } from "../../../learning/control/state.js";
import type { CentralPursuitObjective, CentralPursuitObservation } from "../../../learning/control/decision/pursuit-contract.js";
import type { RewardTarget } from "../../../learning/reward/contracts.js";
import { readCentralPursuitObservations } from "../../learning-allocation/pursuit-observations.js";
import { mapBoardContentArtifacts, type ContentArtifactMapping } from "./artifact.js";

export interface ContentObservationLineageInput {
  readonly board: BoardState;
  readonly scope: string;
  readonly issueId?: string;
  readonly resultRef?: string;
  readonly artifactRef?: string;
  readonly version?: string;
  readonly stageRef?: string;
  readonly feedbackIds?: readonly string[];
  readonly targets?: readonly RewardTarget[];
}

export interface ContentObservationLineageMatch {
  readonly issueId: string;
  readonly grantId: string;
  readonly stageRef: string;
  readonly unitId: string;
  readonly headFactId: string;
  readonly objective: CentralPursuitObjective;
  readonly conditionRef: string;
  readonly sourceRefs: readonly string[];
  readonly matchedBy: readonly ("issue" | "stage" | "observation_source" | "grant_result" | "artifact_output" | "feedback_source")[];
  /** The original owner supplied this effective observation. No label is inferred from the later feedback. */
  readonly observation: CentralPursuitObservation;
  readonly dispatchInput: { readonly status: "unknown"; readonly reason: "original_frozen_dispatch_input_not_recorded";
    readonly sourceRefs: readonly string[] };
}

export type ContentObservationLineageResult =
  | { readonly status: "unique"; readonly match: ContentObservationLineageMatch; readonly matches: readonly ContentObservationLineageMatch[] }
  | { readonly status: "ambiguous"; readonly reason: "multiple_exact_stages"; readonly matches: readonly ContentObservationLineageMatch[] }
  | { readonly status: "unknown"; readonly reason: string; readonly sourceRefs: readonly string[] }
  | { readonly status: "invalid"; readonly reason: string };

function identity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024; }

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function valid(input: ContentObservationLineageInput): boolean {
  return !!input && identity(input.scope) && [input.issueId, input.resultRef, input.artifactRef, input.version, input.stageRef]
    .every(value => value === undefined || identity(value)) && (input.version === undefined || input.artifactRef !== undefined)
    && (input.feedbackIds === undefined || Array.isArray(input.feedbackIds) && input.feedbackIds.length <= 32 && input.feedbackIds.every(identity))
    && (input.targets === undefined || Array.isArray(input.targets) && input.targets.length <= 128 && input.targets.every(target =>
      object(target) && identity(target.kind) && identity(target.id) && identity(target.version)));
}

/** The canonical owner has already validated the complete revision chains and chosen heads.
 * Only recover their original source addresses here; never choose a head or reinterpret an outcome.
 */
function sourceHistory(board: BoardState, heads: readonly { readonly unitId: string; readonly factId: string }[]) {
  const facts = new Map((board.rewardV2Facts ?? []).map(fact => [fact.id, fact]));
  const histories = new Map<string, readonly string[]>();

  for (const head of heads) {
    const refs = new Set<string>(), seen = new Set<string>();
    let current: string | undefined = head.factId;

    while (current !== undefined) {
      if (seen.has(current)) return { ok: false as const, reason: "content_observation_lineage_cycle" };

      seen.add(current);
      const fact = facts.get(current);
      if (!fact) return { ok: false as const, reason: "content_observation_lineage_fact_missing" };

      let raw: unknown;

      try { raw = JSON.parse(fact.payloadJson); }
      catch { return { ok: false as const, reason: "content_observation_lineage_fact_invalid" }; }

      if (!object(raw) || !object(raw.observation) || raw.observation.unitId !== head.unitId
        || !identity(raw.observation.sourceRef) || !identity(raw.observation.revisionRef)
        || raw.observation.supersedes !== undefined && !identity(raw.observation.supersedes)) {
        return { ok: false as const, reason: "content_observation_lineage_fact_invalid" };
      }

      refs.add(current);
      refs.add(raw.observation.sourceRef);
      refs.add(raw.observation.revisionRef);
      current = raw.observation.supersedes;
    }

    histories.set(head.unitId, [...refs]);
  }

  return { ok: true as const, histories };
}

function artifactJobs(board: BoardState, scope: string, artifact: ContentArtifactMapping) {
  const asset = board.assets.find(row => row.versionId === artifact.ref && row.versionId === artifact.version);
  const proposal = asset === undefined ? undefined : board.proposals.find(row => row.proposalId === asset.createdFromProposalId);
  const outputs = new Set([artifact.ref, artifact.version,
    ...(asset?.createdFromProposalId === undefined ? [] : [asset.createdFromProposalId]), ...(proposal === undefined ? [] : [proposal.candidateRef])]);
  return board.jobs.filter(job => job.scope === scope && job.coordination?.resultRefs?.some(ref => outputs.has(ref)));
}

/** Exact provenance lookup only. It supplies the original writer's supersedes address, not a new sample or qualification. */
export function locateContentObservationLineage(input: ContentObservationLineageInput): ContentObservationLineageResult {
  if (!valid(input)) return { status: "invalid", reason: "content_observation_lineage_selector_invalid" };

  if (input.issueId === undefined && input.resultRef === undefined && input.artifactRef === undefined && input.stageRef === undefined
    && (input.feedbackIds?.length ?? 0) === 0 && (input.targets?.length ?? 0) === 0) {
    return { status: "unknown", reason: "no_exact_selector", sourceRefs: [] };
  }

  const owner = readCentralPursuitObservations(input.board, input.scope);
  if (owner.status !== "ready") return { status: "invalid", reason: owner.reason };

  const history = sourceHistory(input.board, owner.heads);
  if (!history.ok) return { status: "invalid", reason: history.reason };

  const requestedFeedback = (input.feedbackIds ?? []).map(id => input.board.rewardFeedbacks?.find(row => row.id === id));
  if (requestedFeedback.some(row => row === undefined)) return { status: "unknown", reason: "feedback_source_missing", sourceRefs: input.feedbackIds ?? [] };

  const feedbacks = requestedFeedback.filter(row => row !== undefined);
  const exposures = feedbacks.map(feedback => input.board.rewardExposures?.find(row => row.id === feedback.exposureId));
  if (exposures.some(row => row === undefined)) return { status: "unknown", reason: "feedback_exposure_missing", sourceRefs: feedbacks.map(row => row.id) };

  const feedbackRefs = [...new Set(feedbacks.flatMap(row => [row.id, row.exposureId, ...row.evidenceIds,
    ...(row.supersedes === undefined ? [] : [row.supersedes])]))];
  const targets = [...(input.targets ?? []), ...exposures.flatMap(row => row?.targets ?? [])];
  let mappings: readonly ContentArtifactMapping[] = [];

  try {
    if (input.artifactRef !== undefined || targets.length > 0) mappings = mapBoardContentArtifacts(input.board, input.scope);
  } catch { return { status: "invalid", reason: "content_observation_artifact_lineage_invalid" }; }

  const artifactMappings = mappings.filter(row => row.ref === input.artifactRef && (input.version === undefined || row.version === input.version));
  const targetedMappings = mappings.filter(row => targets.some(target => target.id === row.ref && target.version === row.version));
  const grants = (input.board.centralLearningGrants ?? []).filter(row => row.scope === input.scope);
  if (new Set(grants.map(row => row.grantId)).size !== grants.length) return { status: "invalid", reason: "content_observation_grant_conflict" };

  const heads = new Map(owner.heads.map(head => [head.unitId, head.factId]));
  const matches: ContentObservationLineageMatch[] = [];
  let missingGrant = false;

  for (const observation of owner.observations) {
    const grant = grants.find(row => row.grantId === observation.grantId);
    if (!grant) {
      missingGrant = true;
      continue;
    }

    if (input.issueId !== undefined && grant.issueId !== input.issueId || input.stageRef !== undefined && observation.stageRef !== input.stageRef) continue;

    const jobs = input.board.jobs.filter(job => job.scope === input.scope && job.jobId === grant.jobId
      && job.coordination?.grantId === grant.grantId && job.coordination.issueId === grant.issueId);
    const originalRefs = history.histories.get(observation.unitId) ?? [];
    const resultSource = input.resultRef !== undefined && originalRefs.includes(input.resultRef);
    const resultJob = input.resultRef !== undefined && jobs.some(job => job.coordination?.resultRefs?.includes(input.resultRef!));
    if (input.resultRef !== undefined && !resultSource && !resultJob) continue;

    const linkedArtifacts = artifactMappings.filter(artifact => originalRefs.includes(artifact.ref) || originalRefs.includes(artifact.version)
      || artifactJobs(input.board, input.scope, artifact).some(job => jobs.some(owned => owned.jobId === job.jobId)));
    if (input.artifactRef !== undefined && linkedArtifacts.length === 0) continue;

    const linkedTargets = targetedMappings.filter(artifact => originalRefs.includes(artifact.ref) || originalRefs.includes(artifact.version)
      || artifactJobs(input.board, input.scope, artifact).some(job => jobs.some(owned => owned.jobId === job.jobId)));
    const directFeedback = feedbackRefs.some(ref => originalRefs.includes(ref));
    if ((input.feedbackIds?.length ?? 0) > 0 && !directFeedback && linkedTargets.length === 0) continue;

    if ((input.targets?.length ?? 0) > 0 && linkedTargets.length === 0) continue;

    const matchedBy: ContentObservationLineageMatch["matchedBy"][number][] = [];

    if (input.issueId !== undefined) matchedBy.push("issue");
    if (input.stageRef !== undefined) matchedBy.push("stage");

    if (resultSource) matchedBy.push("observation_source");
    if (resultJob) matchedBy.push("grant_result");

    if (linkedArtifacts.length > 0 || linkedTargets.length > 0) matchedBy.push("artifact_output");

    if (feedbacks.length > 0 && (directFeedback || linkedTargets.length > 0)) matchedBy.push("feedback_source");

    matches.push({ issueId: grant.issueId, grantId: grant.grantId, stageRef: observation.stageRef, unitId: observation.unitId,
      headFactId: heads.get(observation.unitId)!, objective: observation.objective, conditionRef: observation.conditionRef, observation,
      dispatchInput: { status: "unknown", reason: "original_frozen_dispatch_input_not_recorded", sourceRefs: [grant.jobId, observation.stageRef, heads.get(observation.unitId)!] },
      matchedBy, sourceRefs: [...new Set([grant.grantId, grant.issueId, ...jobs.map(job => job.jobId), ...originalRefs,
        ...(input.resultRef === undefined ? [] : [input.resultRef]),
        ...linkedArtifacts.flatMap(row => row.sourceRefs), ...linkedTargets.flatMap(row => row.sourceRefs), ...feedbackRefs])] });
  }

  if (matches.length === 0) return { status: "unknown", reason: missingGrant ? "original_grant_lineage_missing" : "no_exact_observation",
    sourceRefs: [...new Set([...(input.resultRef === undefined ? [] : [input.resultRef]), ...feedbackRefs])] };

  if (matches.length > 1) return { status: "ambiguous", reason: "multiple_exact_stages", matches };

  return { status: "unique", match: matches[0]!, matches };
}

/** Resolve the recorded user feedback's real exposure and targets. No caller assembles a source DTO or guesses a target. */
export function locateUserFeedbackObservationLineage(input: { readonly board: BoardState; readonly scope: string; readonly feedbackId: string;
  readonly issueId?: string; readonly stageRef?: string }): ContentObservationLineageResult {
  const feedback = input.board.rewardFeedbacks?.find(row => row.id === input.feedbackId);
  if (!feedback || feedback.origin !== "user") return { status: "unknown", reason: "user_feedback_source_missing", sourceRefs: [input.feedbackId] };
  return locateContentObservationLineage({ board: input.board, scope: input.scope, feedbackIds: [input.feedbackId],
    ...(input.issueId === undefined ? {} : { issueId: input.issueId }), ...(input.stageRef === undefined ? {} : { stageRef: input.stageRef }) });
}
