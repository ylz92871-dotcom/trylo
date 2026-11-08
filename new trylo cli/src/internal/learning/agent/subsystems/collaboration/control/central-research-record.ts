import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import { isRewardV2Draft, type RewardV2Draft } from "../../../../reward/v2-facts.js";
import type { CentralLearningIntentDraft, CentralLearningOperation, CentralRuntimeMaterial } from "../../../../central/runtime/contracts.js";
import { isCentralLearningIntent, isCentralLearningOperation, isCentralRuntimeMaterial, isCentralRuntimeReferences } from "../../../../central/runtime/validation.js";
import { fields, text } from "../../../../../validation/json-shape.js";

export const COLLABORATION_CENTRAL_RESEARCH_ALGORITHM = "collaboration-central-research-request/v1";

export type CollaborationCentralResearchRequest = {
  readonly schema: "collaboration-central-research-request/v1";
  readonly scope: string;
  readonly requestRef: string;
  readonly intentRef: string;
  readonly intent: CentralLearningIntentDraft;
  readonly operation: Extract<CentralLearningOperation, { kind: "dispatch" }>;
  readonly materials: readonly CentralRuntimeMaterial[];
  readonly sourceRefs: readonly string[];
};

type Read = { readonly status: "ready"; readonly request: CollaborationCentralResearchRequest }
  | { readonly status: "rejected"; readonly reason: string };

export function isCollaborationCentralResearchRequest(value: unknown): value is CollaborationCentralResearchRequest {
  return fields(value, ["schema", "scope", "requestRef", "intentRef", "intent", "operation", "materials", "sourceRefs"])
    && value.schema === COLLABORATION_CENTRAL_RESEARCH_ALGORITHM
    && [value.scope, value.requestRef, value.intentRef].every(item => text(item, 512))
    && isCentralLearningIntent(value.intent) && value.intentRef === value.intent.intentId && value.intent.subject.plane === "central"
    && value.intent.subject.questionRef === value.intentRef
    && isCentralLearningOperation(value.operation) && value.operation.kind === "dispatch"
    && value.intent.continuation.kind === "ready" && canonicalJson(value.intent.continuation.operation) === canonicalJson(value.operation)
    && (value.operation.destination === undefined || value.operation.destination.plane === "agent"
      && value.operation.destination.domain === "collaboration")
    && Array.isArray(value.materials) && value.materials.length > 0 && value.materials.length <= 256
    && value.materials.every(isCentralRuntimeMaterial) && new Set(value.materials.map(item => item.ref)).size === value.materials.length
    && isCentralRuntimeReferences(value.sourceRefs) && value.sourceRefs.length > 0;
}

/** An immutable public input snapshot. The original issue, grant and worker keep
 * their lifecycles; this projection is neither a second job nor new evidence. */
export function buildCollaborationCentralResearchRecord(request: CollaborationCentralResearchRequest): RewardV2Draft | undefined {
  if (!isCollaborationCentralResearchRequest(request)) return undefined;
  const payloadJson = canonicalJson(request);
  const fact: RewardV2Draft = { id: `collaboration-central-research:${contentHashOf(payloadJson)}`, scope: request.scope,
    algorithmVersion: COLLABORATION_CENTRAL_RESEARCH_ALGORITHM, kind: "projection", payloadJson };
  return isRewardV2Draft(fact) ? fact : undefined;
}

/** A damaged snapshot must never be reconstructed from report prose. */
export function readCollaborationCentralResearchRecord(board: BoardState, scope: string, recordRef: string): Read {
  const fact = board.rewardV2Facts?.find(item => item.id === recordRef);
  if (fact === undefined || fact.scope !== scope || fact.algorithmVersion !== COLLABORATION_CENTRAL_RESEARCH_ALGORITHM
    || fact.kind !== "projection") return { status: "rejected", reason: "collaboration_research_record_missing" };

  let raw: unknown;

  try { raw = JSON.parse(fact.payloadJson); }
  catch { return { status: "rejected", reason: "collaboration_research_record_invalid" }; }

  if (!isCollaborationCentralResearchRequest(raw) || raw.scope !== scope) {
    return { status: "rejected", reason: "collaboration_research_record_invalid" };
  }

  const rebuilt = buildCollaborationCentralResearchRecord(raw);

  return rebuilt?.id === recordRef && rebuilt.payloadJson === fact.payloadJson
    ? { status: "ready", request: raw } : { status: "rejected", reason: "collaboration_research_record_invalid" };
}
