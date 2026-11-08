import type { LearningDomain } from "../../../learning/control/contracts.js";
import type { BoardState } from "../../../learning/control/state.js";
import type { SessionRecordView } from "../../../ports/session.js";
import type { ContentArtifactRef, ContentMaterialBatch } from "../../../learning/central/content/material-contract.js";
import type { ContentFeedbackProjection, FeedbackContentLink } from "../../../learning/central/content/feedback-contracts.js";
import { buildContentFeedbackProjection } from "../../../learning/central/content/feedback.js";
import { readFeedbackExplanation } from "../../reward/explanation-reader.js";
import { contentFeedbackMaterialBatch } from "../source.js";
import { contentSubsystem, mapBoardContentArtifacts } from "./artifact.js";
import { projectContentAdoptions } from "./adoption.js";
import type { ContentAdoptionProjection } from "./adoption-contract.js";
import { automaticTaskCosts, automaticUserFeedback } from "./feedback-observations.js";
import { adoptionFeedbackMaterialBatch } from "./feedback-material.js";
import { sessionContentRecordView } from "./session.js";
import { boardUserFeedbackMaterialBatch } from "./feedback-board.js";
import { selectContentFeedbackMaterial, type FeedbackMaterialTransport } from "./feedback-paging.js";
import { issueUserInputBasisBatch, issueUserInputCandidatesFromAdoptions, withReviewedUserInputProofs } from "./feedback-user-markers.js";

export interface AutomaticContentFeedbackInput {
  readonly board: BoardState;
  readonly scope: string;
  readonly domain: LearningDomain;
  readonly issueId?: string;
  readonly sessionId: string;
  readonly view: SessionRecordView;
  readonly secrets?: readonly string[];
  readonly enabled: () => boolean;
  readonly signal?: AbortSignal;
  readonly delta?: number;
  readonly materialArtifactRefs?: readonly ContentArtifactRef[];
  readonly materialMaximumChars?: number;
  readonly materialMaximumRecords?: number;
}

export type AutomaticContentFeedbackRead = { readonly ok: true; readonly value: {
  readonly batch: ContentMaterialBatch; readonly projection: ContentFeedbackProjection; readonly adoption: ContentAdoptionProjection;
} & Omit<FeedbackMaterialTransport, "batch"> } | { readonly ok: false; readonly reason: string };

/** Capture one real source snapshot and one already-loaded Board snapshot. No caller-maintained links or observations. */
export async function readAutomaticContentFeedback(input: AutomaticContentFeedbackInput): Promise<AutomaticContentFeedbackRead> {
  if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

  if (input.signal?.aborted) return { ok: false, reason: "content_material_cancelled" };

  const read = await readFeedbackExplanation({ enabled: input.enabled, sessionId: input.sessionId, delta: input.delta ?? 0.05,
    source: { readRecords: async () => ({ ok: true, view: input.view }) },
    board: { load: async () => ({ ok: true, state: input.board, generation: 0 }) } });
  if (!read.ok) return { ok: false, reason: read.reason };

  if (!input.enabled()) return { ok: false, reason: "collect_disabled" };

  if (input.signal?.aborted) return { ok: false, reason: "content_material_cancelled" };

  let domainArtifacts;

  try { domainArtifacts = mapBoardContentArtifacts(input.board, input.scope).filter(row => row.domain === input.domain); }
  catch { return { ok: false, reason: "content_feedback_artifact_source_invalid" }; }

  const artifacts = domainArtifacts.filter(row => input.issueId === undefined || row.issueIds.includes(input.issueId));
  const adoption = projectContentAdoptions({ board: input.board, scope: input.scope, sessionId: input.sessionId,
    records: input.view.records, bindings: read.bindings, artifacts });
  const grouped = new Map<string, FeedbackContentLink>();

  for (const adopted of adoption.adoptions) {
    if (adopted.toolUnitId === undefined) continue;

    const binding = read.bindings.find(row => row.unit.unitId === adopted.toolUnitId);
    if (!binding) continue;

    for (const issueId of adopted.artifact.issueIds) {
      if (!input.board.learningIssues?.some(row => row.issueId === issueId && row.scope === input.scope)) continue;

      const key = JSON.stringify([issueId, binding.unit.unitId]);
      const prior = grouped.get(key);
      const artifactRefs = [...(prior?.artifactRefs ?? []), { ref: adopted.artifact.ref, version: adopted.artifact.version }];
      const requirements = input.view.records.filter(row => row.turnId === binding.source.turnId && row.type === "turn_input")
        .flatMap(row => {
          const view = sessionContentRecordView(row, input.scope, input.secrets);
          return view === undefined ? [] : [view.record.ref];
        });

      grouped.set(key, { issueId, scope: input.scope, domain: input.domain,
        ...(adopted.artifact.topicIds.length === 1 ? { topicId: adopted.artifact.topicIds[0]! } : {}),
        artifactRefs: [...new Map(artifactRefs.map(ref => [JSON.stringify(ref), ref])).values()],
        requirementRefs: [...new Set([...(prior?.requirementRefs ?? []), ...requirements])],
        unitId: binding.unit.unitId, ...(binding.exposureId === undefined ? {} : { exposureId: binding.exposureId }), source: binding.source });
    }
  }

  const links = [...grouped.values()];
  let projection;

  try { projection = buildContentFeedbackProjection({ explanation: read, links,
    observations: [...automaticUserFeedback(input.board, links), ...automaticTaskCosts(input.view.records, links)] }); }
  catch { return { ok: false, reason: "content_feedback_association_invalid" }; }

  try {
    const userBasis = input.issueId === undefined ? [] : [issueUserInputBasisBatch({ issueId: input.issueId, subsystem: contentSubsystem(input.domain),
      candidates: withReviewedUserInputProofs({ board: input.board, scope: input.scope, issueId: input.issueId,
        candidates: issueUserInputCandidatesFromAdoptions({ scope: input.scope, issueId: input.issueId, sessionId: input.sessionId,
          records: input.view.records, adoptions: adoption.adoptions, ...(input.secrets === undefined ? {} : { secrets: input.secrets }) }) }) })];
    const transport = selectContentFeedbackMaterial({ batches: [...userBasis, contentFeedbackMaterialBatch(projection, input.scope),
      adoptionFeedbackMaterialBatch({ adoption, records: input.view.records, scope: input.scope, sessionId: input.sessionId,
        ...(input.secrets === undefined ? {} : { secrets: input.secrets }) }),
      boardUserFeedbackMaterialBatch({ board: input.board, scope: input.scope, subsystem: contentSubsystem(input.domain), artifacts: domainArtifacts,
        ...(input.issueId === undefined ? {} : { issueId: input.issueId }) })], scope: input.scope,
      ...(input.issueId === undefined ? {} : { issueId: input.issueId }),
      ...(input.materialArtifactRefs === undefined ? {} : { artifactRefs: input.materialArtifactRefs }),
      ...(input.materialMaximumChars === undefined ? {} : { maximumChars: input.materialMaximumChars }),
      ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
      ...(input.materialMaximumRecords === undefined ? {} : { maximumRecords: input.materialMaximumRecords }) });

    return { ok: true, value: { ...transport, projection, adoption } };
  } catch { return { ok: false, reason: "content_feedback_material_transport_invalid" }; }
}
