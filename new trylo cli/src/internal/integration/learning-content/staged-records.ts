import type { ContentPacket } from "../../learning/central/content/material-contract.js";
import { readContentPacket } from "../../learning/central/content/material.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isRewardV2Draft, type RewardV2Draft, type RewardV2Fact } from "../../learning/reward/v2-facts.js";

export const CONTENT_STAGE_ALGORITHM = "central-content-pa-stages-v1";

export type ContentStageBody = {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly turnId: string;
} & (
  | { readonly kind: "prepared"; readonly requestId: string; readonly packet: ContentPacket; readonly maximumPromptChars: number;
      readonly requestHash: string; readonly extendsStageRef?: string }
  | { readonly kind: "applied"; readonly preparationRef: string; readonly applicationJson: string; readonly requestHash: string }
  | { readonly kind: "reviewed"; readonly applicationRef: string; readonly reviewJson: string }
);

export interface ContentStageRecord { readonly ref: string; readonly sequence: number; readonly body: ContentStageBody }

function body(value: unknown): value is ContentStageBody {
  return prepared(value) || applied(value) || reviewed(value);
}

function prepared(value: unknown): value is Extract<ContentStageBody, { readonly kind: "prepared" }> {
  const extended = typeof value === "object" && value !== null && "extendsStageRef" in value;
  return fields(value, ["schemaVersion", "sessionId", "turnId", "kind", "requestId", "packet", "maximumPromptChars", "requestHash", ...(extended ? ["extendsStageRef"] : [])])
      && value.kind === "prepared" && value.schemaVersion === 1 && identity(value.sessionId) && identity(value.turnId)
      && identity(value.requestId) && readContentPacket(value.packet).ok && sequence(value.maximumPromptChars) && value.maximumPromptChars >= 1
      && value.maximumPromptChars <= 100000 && typeof value.requestHash === "string" && /^[a-f0-9]{64}$/.test(value.requestHash)
      && (!extended || identity(value.extendsStageRef));
}

function applied(value: unknown): value is Extract<ContentStageBody, { readonly kind: "applied" }> {
  return fields(value, ["schemaVersion", "sessionId", "turnId", "kind", "preparationRef", "applicationJson", "requestHash"])
    && value.schemaVersion === 1 && value.kind === "applied" && identity(value.sessionId) && identity(value.turnId)
    && identity(value.preparationRef) && typeof value.applicationJson === "string" && value.applicationJson.length <= 65536
    && typeof value.requestHash === "string" && /^[a-f0-9]{64}$/.test(value.requestHash);
}

function reviewed(value: unknown): value is Extract<ContentStageBody, { readonly kind: "reviewed" }> {
  return fields(value, ["schemaVersion", "sessionId", "turnId", "kind", "applicationRef", "reviewJson"])
    && value.schemaVersion === 1 && value.kind === "reviewed" && identity(value.sessionId) && identity(value.turnId)
    && identity(value.applicationRef) && typeof value.reviewJson === "string" && value.reviewJson.length <= 65536;
}

export function contentStageDraft(scope: string, value: ContentStageBody): RewardV2Draft {
  if (!body(value)) throw new TypeError("content_stage_shape");
  const payloadJson = canonicalJson(value);
  const draft = { id: `content-stage:${contentHashOf([scope, payloadJson])}`, scope, algorithmVersion: CONTENT_STAGE_ALGORITHM,
    kind: "projection" as const, payloadJson };
  if (!isRewardV2Draft(draft)) throw new RangeError("content_stage_capacity");
  return draft;
}

/** Stage records are only immutable model inputs/results. The issue, grant and asset owners are unchanged. */
export function contentStageRecords(facts: readonly RewardV2Fact[], scope: string, through: number): readonly ContentStageRecord[] {
  return facts.filter(fact => fact.scope === scope && fact.sequence <= through && fact.algorithmVersion === CONTENT_STAGE_ALGORITHM).map(fact => {
    const value: unknown = JSON.parse(fact.payloadJson);
    if (fact.kind !== "projection" || !body(value) || contentStageDraft(scope, value).id !== fact.id
      || value.kind === "prepared" && value.packet.scope !== scope) throw new TypeError("content_stage_corrupt");
    return { ref: fact.id, sequence: fact.sequence, body: value };
  });
}
