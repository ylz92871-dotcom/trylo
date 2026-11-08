import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { projectCentralStageCost } from "../../learning/control/decision/prediction-cost.js";
import { isCentralResponseOpportunity, isCentralResponseTarget } from "../../learning/control/decision/prediction-validation.js";
import { isCentralLearningGrant } from "../../learning/control/coordination-parse.js";
import { isEmpiricalTopicPolicy } from "../../learning/domains/shared/topics/empirical-model.js";
import type { CentralResponseCost } from "../../learning/control/decision/prediction-input.js";
import type { CentralLearningGrant } from "../../learning/control/coordination-contract.js";
import { topicMeasurements } from "../learning-topics/measurement-source.js";
import { buildCentralResponseHistoryFromBoard } from "../learning-allocation/response-source.js";
import { centralResponseWindowsOf } from "../learning-allocation/response-registration.js";
import type { CentralResponseWindow } from "../learning-allocation/response-source.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import type { ContentHistoryEvidence, ContentHistorySourceBinding, ContentLearningHistoryInput, ContentLearningHistoryProjection,
  ContentLearningSourceChain } from "./history-contract.js";

export type { ContentHistorySourceBinding, ContentLearningHistoryInput, ContentLearningHistoryProjection,
  ContentLearningSourceChain } from "./history-contract.js";

function sourceRefs(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 32 && value.every(identity) && new Set(value).size === value.length;
}

function validChain(value: unknown): value is ContentLearningSourceChain {
  if (fields(value, ["kind", "issueId", "reason", "sourceRefs"])) return value.kind === "unknown"
    && identity(value.issueId) && identity(value.reason) && sourceRefs(value.sourceRefs);

  if (!fields(value, ["kind", "issueId", "grantId", "result", "adoption", "registration", "sourceRefs"])
    || value.kind !== "traced" || !identity(value.issueId) || !identity(value.grantId) || !sourceRefs(value.sourceRefs)) return false;

  return fields(value.result, ["ref", "artifactRef", "version"]) && Object.values(value.result).every(identity)
    && fields(value.adoption, ["ref", "artifactRef", "version", "unitId", "windowRef"])
    && Object.values(value.adoption).every(identity)
    && fields(value.registration, ["ref", "unitId", "windowRef"]) && Object.values(value.registration).every(identity);
}

function validSource(value: unknown): value is ContentHistorySourceBinding {
  if (!fields(value, ["window", "chain", "usage"]) || !validChain(value.chain)
    || !fields(value.window, ["opportunity", "unitId", "registeredAtSequence", "grantId", "measurementIds", "comparison", "boundary"])) return false;
  const window = value.window;
  return identity(window.unitId) && identity(window.grantId) && isCentralResponseOpportunity(window.opportunity)
    && window.comparison !== null && typeof window.comparison === "object" && !Array.isArray(window.comparison);
}

/** Missing lineage changes qualification, never the original record or numeric measurement. */
function projectedWindow(source: ContentHistorySourceBinding, grant: CentralLearningGrant) {
  const { window, chain } = source;

  if (grant.issueId !== chain.issueId) return undefined;

  if (chain.kind === "unknown") return { ...window, comparison: { kind: "unqualified" as const, reason: chain.reason } };

  if (chain.grantId !== grant.grantId) return undefined;

  const sameArtifact = chain.result.artifactRef === chain.adoption.artifactRef && chain.result.version === chain.adoption.version;
  const sameWindow = chain.adoption.unitId === window.unitId && chain.registration.unitId === window.unitId
    && chain.adoption.windowRef === window.opportunity.windowRef && chain.registration.windowRef === window.opportunity.windowRef;
  if (!sameArtifact || !sameWindow) return undefined;

  if (window.comparison.kind === "unqualified") return window;

  const comparison = window.comparison;

  // The original result/adoption chain does not certify a policy-assignment contrast.
  // That newer comparison remains with its canonical registration/assignment source.
  if (comparison.kind !== "deployed_learning_vs_frozen_baseline") return undefined;

  const linksMatch = comparison.resultRef === chain.result.ref && comparison.adoptionRef === chain.adoption.ref
    && comparison.registrationRef === chain.registration.ref;
  if (!linksMatch || ![chain.result.ref, chain.adoption.ref, chain.registration.ref].every(ref => chain.sourceRefs.includes(ref))) return undefined;

  return window;
}

function stageCost(source: ContentHistorySourceBinding, grant: CentralLearningGrant): CentralResponseCost | undefined {
  if (source.usage === null) return { status: "unknown", grantId: grant.grantId,
    sourceRef: `content-spend:${contentHashOf({ grantId: grant.grantId, unitId: source.window.unitId })}`,
    reason: "content_stage_usage_boundary_missing" };
  const projected = projectCentralStageCost({ ...source.usage, grant });
  return projected.status === "ready" ? projected.cost : undefined;
}

/** Thin source adapter. The canonical response-source owns window eligibility and revision
 * resolution; prediction-cost owns stage spend. No learning-effect label is inferred here. */
export function projectContentLearningHistory(input: ContentLearningHistoryInput): ContentLearningHistoryProjection {
  if (!fields(input, ["board", "target", "measurementPolicy", "sources"]) || !sequence(input.board?.sequence)
    || !isCentralResponseTarget(input.target) || !isEmpiricalTopicPolicy(input.measurementPolicy)
    || !Array.isArray(input.sources) || input.sources.length > 512
    || !input.sources.every(validSource)) {
    return { status: "invalid", reason: "content_history_input" };
  }

  const windows: CentralResponseWindow[] = [], evidence: ContentHistoryEvidence[] = [];
  const registered = centralResponseWindowsOf(input.board, input.target, input.measurementPolicy.scope);
  if (registered.status !== "ready") return registered;

  const costs: { readonly unitId: string; readonly cost: CentralResponseCost }[] = [];
  const consumedReservations = new Set<string>();

  for (const source of input.sources) {
    // Use the original Board birth and fixed cohort. A host DTO cannot backdate registration.
    const original = registered.value.find(window => window.unitId === source.window.unitId);
    if (original === undefined || canonicalJson(original) !== canonicalJson(source.window)) {
      return { status: "invalid", reason: "content_history_window_unregistered" };
    }

    if (original.comparison.kind === "learning_policy_vs_frozen_baseline") {
      return { status: "invalid", reason: "content_history_policy_assignment_lineage_required" };
    }

    const grant = input.board.centralLearningGrants?.find(row => row.grantId === source.window.grantId);
    if (grant === undefined || !isCentralLearningGrant(grant)) return { status: "invalid", reason: "content_history_grant_missing" };

    const window = projectedWindow(source, grant), cost = stageCost(source, grant);
    if (window === undefined || cost === undefined) return { status: "invalid", reason: "content_history_lineage_conflict" };

    // One model bill cannot become two independent stage costs through repeated source links.
    for (const id of source.usage?.reservationIds ?? []) {
      const key = canonicalJson([grant.grantId, id]);
      if (consumedReservations.has(key)) return { status: "invalid", reason: "content_history_reused_reservation" };
      consumedReservations.add(key);
    }

    windows.push(window);
    costs.push({ unitId: window.unitId, cost });
    evidence.push({ unitId: window.unitId, opportunityId: window.opportunity.opportunityId, grantId: grant.grantId,
      chain: source.chain, sourceWindow: source.window, projectedWindow: window,
      reservationIds: source.usage?.reservationIds ?? [], measurementIds: window.measurementIds });
  }

  const projected = buildCentralResponseHistoryFromBoard({ board: input.board, target: input.target,
    measurementPolicy: input.measurementPolicy, windows });
  if (projected.status !== "ready") return projected;

  const pairedRecords = topicMeasurements(input.board.rewardV2Facts ?? [], input.measurementPolicy.scope)
    .filter(row => row.sequence <= input.board.sequence);

  return { status: "ready", schemaVersion: 1, boardSequence: input.board.sequence, sourceRef: projected.sourceRef,
    history: projected.history, costs, pairedRecords, evidence };
}
