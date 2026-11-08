import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import type { RewardV2Draft } from "../../../../reward/v2-facts.js";
import { isRewardV2Draft } from "../../../../reward/v2-facts.js";
import { fields, identity, list, text } from "../../../../../validation/json-shape.js";
import type { CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../../../central/runtime/contracts.js";
import { isCentralLearningIntent, isCentralRuntimeMaterial } from "../../../../central/runtime/validation.js";
import { isScopePredicate, type ScopePredicate } from "../domain/scope-learning.js";
import { redactJsonValue } from "../../../../../protocol/redact.js";

export const METHOD_RESEARCH_ALGORITHM = "central-method-research-v1";

export interface MethodResearchRequest {
  readonly type: "method_research_request"; readonly schemaVersion: 1;
  readonly requestRef: string; readonly intentRef: string; readonly intent: CentralLearningIntentDraft;
  readonly materials: readonly CentralRuntimeMaterial[]; readonly sourceRefs: readonly string[];
}

export interface MethodResearchFinding {
  readonly kind: "finding" | "candidate" | "waiting" | "stopped";
  readonly statement: string; readonly conditions: string;
  readonly sourceRefs: readonly string[]; readonly residual: readonly string[];
  readonly candidate?: { readonly hint: string; readonly scope: { readonly description: string; readonly predicate: ScopePredicate } };
}

export interface MethodResearchStep {
  readonly type: "method_research_step"; readonly schemaVersion: 1;
  readonly requestRef: string; readonly previousRef: string; readonly reservationId: string;
  readonly contextRef: string;
  /** Older research checkpoints remain readable but cannot qualify a frozen stage. */
  readonly stageInputHash?: string;
  readonly finding: MethodResearchFinding;
}

/** A durable host observation that no provider call was started. It advances
 * the native cursor without inventing a finding or reopening its reservation. */
export interface MethodResearchUnsent {
  readonly type: "method_research_unsent"; readonly schemaVersion: 1;
  readonly requestRef: string; readonly previousRef: string; readonly reservationId: string;
  readonly contextRef: string; readonly stageInputHash: string;
  readonly reason: "deadline_before_send" | "cancelled_before_send";
}

/** A completed, paid response rejected by the output contract. This is neither
 * an unsent call nor a research finding, and never qualifies a candidate. */
export interface MethodResearchRejected {
  readonly type: "method_research_rejected"; readonly schemaVersion: 1;
  readonly requestRef: string; readonly previousRef: string; readonly reservationId: string;
  readonly contextRef: string; readonly stageInputHash: string;
  readonly reason: "method_research_output_invalid";
  readonly evidence: { readonly kind: "response"; readonly outputHash: string; readonly rejectedField?: string }
    | { readonly kind: "native_finish"; readonly commandId: string };
}

type RecordValue = MethodResearchRequest | MethodResearchStep | MethodResearchUnsent | MethodResearchRejected;

const refs = (value: unknown): value is readonly string[] => list(value, 1, 32) && value.every(identity)
  && new Set(value).size === value.length;

export function isMethodResearchFinding(value: unknown): value is MethodResearchFinding {
  return rejectedMethodResearchField(value) === undefined;
}

/** One validator owns acceptance and the public field diagnostic. A rejection
 * names structure only; it does not store provider prose or invent a finding. */
export function rejectedMethodResearchField(value: unknown): string | undefined {
  if (!fields(value, ["kind", "statement", "conditions", "sourceRefs", "residual",
    ...(typeof value === "object" && value !== null && Object.hasOwn(value, "candidate") ? ["candidate"] : [])])) return "object_fields";

  if (!["finding", "candidate", "waiting", "stopped"].includes(String(value.kind))) return "kind";

  if (!text(value.statement, 6000)) return "statement";

  if (!text(value.conditions, 3000)) return "conditions";

  if (!refs(value.sourceRefs)) return "sourceRefs";

  if (!list(value.residual, 0, 16) || !value.residual.every(item => text(item, 2000))) return "residual";

  if (value.kind !== "candidate") return Object.hasOwn(value, "candidate") ? "candidate_for_non_candidate_kind" : undefined;

  if (!fields(value.candidate, ["hint", "scope"])) return "candidate.object_fields";

  if (!text(value.candidate.hint, 200)) return "candidate.hint";

  if (!fields(value.candidate.scope, ["description", "predicate"])) return "candidate.scope.object_fields";

  if (!text(value.candidate.scope.description, 1500)) return "candidate.scope.description";

  return isScopePredicate(value.candidate.scope.predicate) ? undefined : "candidate.scope.predicate";
}

function isRecord(value: unknown): value is RecordValue {
  if (fields(value, ["type", "schemaVersion", "requestRef", "previousRef", "reservationId", "contextRef", "stageInputHash", "reason", "evidence"])) {
    return value.type === "method_research_rejected" && value.schemaVersion === 1
      && [value.requestRef, value.previousRef, value.reservationId, value.contextRef].every(identity)
      && typeof value.stageInputHash === "string" && /^[a-f0-9]{64}$/.test(value.stageInputHash)
      && value.reason === "method_research_output_invalid"
      && (fields(value.evidence, ["kind", "outputHash", ...(typeof value.evidence === "object" && value.evidence !== null
        && Object.hasOwn(value.evidence, "rejectedField") ? ["rejectedField"] : [])]) && value.evidence.kind === "response"
        && typeof value.evidence.outputHash === "string" && /^[a-f0-9]{64}$/.test(value.evidence.outputHash)
        && (!Object.hasOwn(value.evidence, "rejectedField") || text(value.evidence.rejectedField, 160))
        || fields(value.evidence, ["kind", "commandId"]) && value.evidence.kind === "native_finish" && identity(value.evidence.commandId));
  }

  if (fields(value, ["type", "schemaVersion", "requestRef", "intentRef", "intent", "materials", "sourceRefs"])) {
    return value.type === "method_research_request" && value.schemaVersion === 1 && identity(value.requestRef)
      && identity(value.intentRef) && isCentralLearningIntent(value.intent) && value.intent.intentId === value.intentRef
      && list(value.materials, 1, 64) && value.materials.every(isCentralRuntimeMaterial) && refs(value.sourceRefs);
  }

  if (fields(value, ["type", "schemaVersion", "requestRef", "previousRef", "reservationId", "contextRef", "stageInputHash", "reason"])) {
    return value.type === "method_research_unsent" && value.schemaVersion === 1 && identity(value.requestRef)
      && identity(value.previousRef) && identity(value.reservationId) && identity(value.contextRef)
      && typeof value.stageInputHash === "string" && /^[a-f0-9]{64}$/.test(value.stageInputHash)
      && (value.reason === "deadline_before_send" || value.reason === "cancelled_before_send");
  }

  return fields(value, ["type", "schemaVersion", "requestRef", "previousRef", "reservationId", "contextRef", "finding",
    ...(typeof value === "object" && value !== null && Object.hasOwn(value, "stageInputHash") ? ["stageInputHash"] : [])])
    && value.type === "method_research_step" && value.schemaVersion === 1 && identity(value.requestRef)
    && identity(value.previousRef) && identity(value.reservationId) && identity(value.contextRef) && isMethodResearchFinding(value.finding)
    && (!Object.hasOwn(value, "stageInputHash") || typeof value.stageInputHash === "string" && /^[a-f0-9]{64}$/.test(value.stageInputHash));
}

export function methodResearchRecord(scope: string, value: RecordValue): RewardV2Draft {
  if (!isRecord(value)) throw new Error("method_research_record_invalid");
  const payloadJson = canonicalJson(value);
  const fact: RewardV2Draft = { id: `method-research-record:${contentHashOf(payloadJson)}`, scope,
    algorithmVersion: METHOD_RESEARCH_ALGORITHM, kind: "projection", payloadJson };
  if (!isRewardV2Draft(fact)) throw new Error("method_research_record_capacity");
  return fact;
}

/** Records are public research, never observations, qualification or active method assets. */
export function readMethodResearch(state: BoardState, scope: string, requestRef: string) {
  let request: MethodResearchRequest | undefined, requestId: string | undefined;
  const steps: { readonly ref: string; readonly step: MethodResearchStep }[] = [];
  const checkpoints: { readonly ref: string; readonly step: MethodResearchStep | MethodResearchUnsent | MethodResearchRejected }[] = [];

  for (const fact of state.rewardV2Facts ?? []) {
    if (fact.scope !== scope || fact.algorithmVersion !== METHOD_RESEARCH_ALGORITHM) continue;

    let value: unknown;

    try { value = JSON.parse(fact.payloadJson); }
    catch { throw new Error("method_research_record_corrupt"); }

    if (!isRecord(value) || fact.kind !== "projection" || methodResearchRecord(scope, value).id !== fact.id) {
      throw new Error("method_research_record_corrupt");
    }

    if (value.requestRef !== requestRef) continue;

    if (value.type === "method_research_request") {
      if (request !== undefined) throw new Error("method_research_request_conflict");
      request = value;
      requestId = fact.id;
    } else {
      if (request === undefined || value.previousRef !== (checkpoints.at(-1)?.ref ?? requestId)
        || checkpoints.some(row => row.step.reservationId === value.reservationId)) throw new Error("method_research_chain_corrupt");

      if (value.type === "method_research_unsent") {
        const grant = state.centralLearningGrants?.find(row => row.grantId === methodResearchGrantId(value.requestRef) && row.scope === scope);
        const reservation = grant?.reservations.find(row => row.reservationId === value.reservationId);
        if (reservation?.state !== "settled" || reservation.usage?.kind !== "reported" || reservation.usage.totalTokens !== 0
          || reservation.usage.inputTokens !== 0 || reservation.usage.outputTokens !== 0) throw new Error("method_research_unsent_reservation_unconfirmed");
      } else if (value.type === "method_research_rejected") {
        const grant = state.centralLearningGrants?.find(row => row.grantId === methodResearchGrantId(value.requestRef) && row.scope === scope);
        const reservation = grant?.reservations.find(row => row.reservationId === value.reservationId);
        if (reservation?.state !== "settled" || reservation.usage?.kind !== "reported") throw new Error("method_research_rejected_reservation_unconfirmed");
      } else {
        const allowed = new Set([request.requestRef, request.intentRef, ...request.sourceRefs,
          ...request.materials.flatMap(row => [row.ref, ...row.sourceRefs]), ...steps.map(row => row.ref)]);
        if (value.finding.sourceRefs.some(ref => !allowed.has(ref))) throw new Error("method_research_finding_source_missing");
        steps.push({ ref: fact.id, step: value });
      }

      checkpoints.push({ ref: fact.id, step: value });
    }
  }

  return request === undefined || requestId === undefined ? undefined
    : { request, requestId, steps, checkpoints, headRef: checkpoints.at(-1)?.ref ?? requestId };
}

export const methodResearchIssueId = (requestRef: string) => `method-research-issue:${contentHashOf(requestRef)}`;
export const methodResearchGrantId = (requestRef: string) => `method-research-grant:${contentHashOf(requestRef)}`;

export function readCentralMethodResearchMaterial(state: BoardState, scope: string, ref: string): CentralRuntimeMaterial | undefined {
  const fact = state.rewardV2Facts?.find(row => row.id === ref && row.scope === scope && row.algorithmVersion === METHOD_RESEARCH_ALGORITHM);
  if (fact === undefined) return undefined;

  let value: unknown;

  try { value = JSON.parse(fact.payloadJson); }
  catch { throw new Error("method_research_record_corrupt"); }

  if (!isRecord(value)) throw new Error("method_research_record_corrupt");

  const history = readMethodResearch(state, scope, value.requestRef);
  if (history === undefined) throw new Error("method_research_request_missing");

  // The original record/chain stays immutable. Public delivery uses the same
  // path/secret redactor as other learning materials, including nested metadata.
  const publicValue = redactJsonValue(JSON.parse(fact.payloadJson));

  return { ref, kind: value.type === "method_research_request" ? "source" : "work_result",
    text: canonicalJson({ interpretation: value.type === "method_research_rejected" ? "paid_response_rejected_no_model_finding"
      : value.type === "method_research_unsent" ? "confirmed_not_sent_no_model_finding"
      : "public_method_research_not_independent_evidence_or_adopted_method", value: publicValue,
      ...(canonicalJson(publicValue) === fact.payloadJson ? {} : { representation: "redacted_public_view" }) }),
    sourceRefs: [...new Set([value.requestRef, history.request.intentRef, ...history.request.sourceRefs])] };
}
