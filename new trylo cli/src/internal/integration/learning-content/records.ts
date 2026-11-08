import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isRewardV2Draft, type RewardV2Draft, type RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { fields } from "../../validation/json-shape.js";
import { readContentPacket } from "../../learning/central/content/material.js";
import type { ContentPacket } from "../../learning/central/content/material-contract.js";
import { compileContentProcess, type ContentProcessOutput } from "../../learning/central/content/process.js";
import { buildContentTopicHandoff, type ContentTopicHandoff } from "../../learning/central/content/topic-handoff.js";

export const CONTENT_ALGORITHM = "central-learning-content-v1";

export interface ContentRecord {
  readonly packet: ContentPacket;
  readonly output: ContentProcessOutput;
  readonly handoff: ContentTopicHandoff | { readonly kind: "unavailable"; readonly reason: string };
}

/** Same opaque-fact Board owner and collection policy as WS1. No second issue/answer database. */
export function buildContentRecord(packet: ContentPacket, output: ContentProcessOutput): RewardV2Draft {
  const admitted = readContentPacket(packet);
  if (!admitted.ok) throw new Error(admitted.reason);

  const rebuilt = compileContentProcess(admitted.value, canonicalJson(output.applied), canonicalJson(output.review));
  if (!rebuilt.ok) throw new Error(rebuilt.reason);

  if (canonicalJson(rebuilt.value) !== canonicalJson(output)) throw new Error("content_output_conflict");

  const payloadJson = canonicalJson({ schemaVersion: 1, type: "central_learning_content", packet: admitted.value,
    applied: rebuilt.value.applied, review: rebuilt.value.review });
  const draft: RewardV2Draft = { id: `content-record:${contentHashOf(payloadJson)}`, scope: packet.scope,
    algorithmVersion: CONTENT_ALGORITHM, kind: "projection", payloadJson };
  if (!isRewardV2Draft(draft)) throw new Error("content_capacity");

  return draft;
}

/** Strict replay rechecks original citations, packet hash and semantic reference closure. */
export function readContentRecords(facts: readonly RewardV2Fact[], scope: string, boardSequence: number):
  readonly (ContentRecord & { readonly factId: string; readonly sequence: number })[] {
  return facts.filter(fact => fact.scope === scope && fact.sequence <= boardSequence && fact.algorithmVersion === CONTENT_ALGORITHM).map(fact => {
    const raw: unknown = JSON.parse(fact.payloadJson);
    if (fact.kind !== "projection" || !fields(raw, ["schemaVersion", "type", "packet", "applied", "review"])
      || raw.schemaVersion !== 1 || raw.type !== "central_learning_content") throw new Error("content_record_corrupt");

    const packet = readContentPacket(raw.packet);
    if (!packet.ok || packet.value.scope !== scope || packet.value.boardSequence >= fact.sequence) throw new Error("content_record_corrupt");

    const output = compileContentProcess(packet.value, canonicalJson(raw.applied), canonicalJson(raw.review));
    if (!output.ok) throw new Error(output.reason);

    const rebuilt = buildContentRecord(packet.value, output.value);
    if (rebuilt.id !== fact.id || rebuilt.payloadJson !== fact.payloadJson) throw new Error("content_record_corrupt");

    const handoff = buildContentTopicHandoff(packet.value, output.value);

    return { factId: fact.id, sequence: fact.sequence, packet: packet.value, output: output.value,
      handoff: handoff.ok ? handoff.value : { kind: "unavailable" as const, reason: handoff.reason } };
  });
}
