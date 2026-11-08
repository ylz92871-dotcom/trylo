import { canonicalJson, contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import type { EmpiricalDecisionProjection, EmpiricalTopicModel, EmpiricalTopicPolicy } from "../../learning/domains/shared/topics/empirical-model.js";

type Evidence = Extract<EmpiricalTopicModel, { readonly status: "ready" }>["provenance"];

// 512 maximum-length (256 UTF-16 units) identities plus record fields fit this bounded source window.
const MAX_SOURCE_CHARS = 262144, MAX_SOURCE_BYTES = 1048576;
const INLINE_BYTES = 2048, MAX_PROVENANCE_BYTES = 12288;

type Digest = { readonly digest: string; readonly canonicalBytes: number };

type Representation = Digest & (
  | { readonly representation: "inline"; readonly value: unknown }
  | { readonly representation: "digest_only" }
);

/** A whole value or its whole-value digest, never a truncated value presented as complete. */
function represent(value: unknown): Representation {
  const json = canonicalJson(value), summary = { digest: sha256Hex(json), canonicalBytes: Buffer.byteLength(json, "utf8") };
  const inline = { ...summary, representation: "inline" as const, value };
  return Buffer.byteLength(canonicalJson(inline), "utf8") <= INLINE_BYTES ? inline : { ...summary, representation: "digest_only" };
}

export { represent as representTopicProvenanceValue };

/** Long support/projection sets are reproduced from the same Board prefix, not copied to another store. */
export function compactTopicProvenance(input: {
  readonly boardSequence: number; readonly policy: EmpiricalTopicPolicy; readonly modelJson: string;
  readonly evidence: Evidence; readonly decision: EmpiricalDecisionProjection; readonly decisionSourceJson: string;
  readonly demand?: { readonly futureUses: number; readonly basisHash: string; readonly sourceJson: string };
}): { readonly json: string; readonly hash: string } | undefined {
  if (typeof input.decisionSourceJson !== "string" || input.decisionSourceJson.length > MAX_SOURCE_CHARS
    || Buffer.byteLength(input.decisionSourceJson, "utf8") > MAX_SOURCE_BYTES) return undefined;

  let source: unknown;

  try { source = JSON.parse(input.decisionSourceJson); }
  catch { return undefined; }

  let demand: unknown;
  if (input.demand !== undefined) {
    if (typeof input.demand.sourceJson !== "string" || input.demand.sourceJson.length > 262144
      || Buffer.byteLength(input.demand.sourceJson, "utf8") > 1048576 || !/^[a-f0-9]{64}$/.test(input.demand.basisHash)) return undefined;
    try { demand = { futureUses: input.demand.futureUses, basisHash: input.demand.basisHash, source: JSON.parse(input.demand.sourceJson) }; }
    catch { return undefined; }
  }

  const { supportIds, ...record } = input.evidence;
  const provenance = { schemaVersion: 1, representation: "board_prefix_summary", boardSequence: input.boardSequence,
    policy: represent(input.policy),
    // The original fixed model remains in the valuation's modelJson field, without another embedded copy.
    model: { representation: "separate_model_json", digest: sha256Hex(input.modelJson), bytes: Buffer.byteLength(input.modelJson, "utf8") },
    evidence: { representation: "board_prefix_digest", digest: contentHashOf(input.evidence), record: represent(record),
      support: { representation: "board_prefix_digest", count: supportIds.length, digest: contentHashOf(supportIds) } },
    ...(input.demand === undefined ? {} : { demand: represent(demand) }),
    decision: { currentAction: input.decision.currentAction, ...(input.decision.basisHash === undefined ? {} : { basisHash: input.decision.basisHash }),
      digest: contentHashOf(input.decision), projections: { representation: "board_prefix_digest",
        count: input.decision.projections.length, digest: contentHashOf(input.decision.projections) }, source: represent(source) } };
  const json = canonicalJson(provenance);

  // Four bounded inline components plus scalar/digest summaries stay below this limit even at 512 support rows.
  if (Buffer.byteLength(json, "utf8") > MAX_PROVENANCE_BYTES) throw new Error("topic_provenance_capacity");

  return { json, hash: sha256Hex(json) };
}
