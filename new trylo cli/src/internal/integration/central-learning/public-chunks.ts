import type { RewardV2Draft, RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { isRewardV2Draft, isRewardV2Fact } from "../../learning/reward/v2-facts.js";
import { canonicalJson, contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import { fields, identity, list } from "../../validation/json-shape.js";

/** The original public-delivery archive's representation limits, independent of
 * model context and learning authorization. A manifest commits all fragments. */
export const CENTRAL_PUBLIC_CHUNKS = Object.freeze({ chunkChars: 8192, payloadChars: 1024 * 1024, chunks: 128 });

export type CentralPublicChunkAddress = { readonly scope: string; readonly namespace: string; readonly ref: string };

export class CentralPublicChunkError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CentralPublicChunkError";
  }
}

const fail = (reason: string): never => { throw new CentralPublicChunkError(reason); };
const manifestId = (address: CentralPublicChunkAddress) => `central-public-manifest:${contentHashOf(address)}`;
const chunkId = (address: CentralPublicChunkAddress, hash: string, index: number, part: string) =>
  `central-public-chunk:${contentHashOf([address, hash, index, part])}`;

function draft(address: CentralPublicChunkAddress, kind: "chunk" | "manifest", id: string, value: unknown): RewardV2Draft {
  const fact = { scope: address.scope, algorithmVersion: `${address.namespace}:${kind}:v1`, id,
    kind: "projection" as const, payloadJson: canonicalJson(value) };
  return isRewardV2Draft(fact) ? fact : fail("central_public_chunk_capacity");
}

function parse(value: string): unknown {
  try { return JSON.parse(value); }
  catch { return fail("central_public_chunk_corrupt"); }
}

/** Pure encoding only. The caller writes fragments first and the manifest last. */
export function encodeCentralPublicChunks(address: CentralPublicChunkAddress, payload: string) {
  if (!identity(address.namespace) || payload.length < 1 || payload.length > CENTRAL_PUBLIC_CHUNKS.payloadChars) {
    return fail("central_public_chunk_capacity");
  }

  const payloadHash = sha256Hex(payload), fragments: RewardV2Draft[] = [];

  for (let start = 0, index = 0; start < payload.length; start += CENTRAL_PUBLIC_CHUNKS.chunkChars, index += 1) {
    const part = payload.slice(start, start + CENTRAL_PUBLIC_CHUNKS.chunkChars);
    fragments.push(draft(address, "chunk", chunkId(address, payloadHash, index, part), {
      schemaVersion: 1, type: "central_public_fragment", ref: address.ref, payloadHash, index, text: part }));
  }

  const manifest = draft(address, "manifest", manifestId(address), { schemaVersion: 1, type: "central_public_manifest",
    ref: address.ref, payloadHash, chunks: fragments.map(fact => fact.id) });

  return { fragments, manifest };
}

/** A complete verified manifest is required. Orphan fragments never become a
 * readable body; scope, every fragment and the full payload keep exact hashes. */
export function readCentralPublicChunks(facts: readonly RewardV2Fact[], address: CentralPublicChunkAddress): string | undefined {
  const committed = facts.find(fact => fact.id === manifestId(address));
  if (committed === undefined) return undefined;

  const value = parse(committed.payloadJson);
  if (!isRewardV2Fact(committed) || committed.scope !== address.scope || committed.kind !== "projection"
    || committed.algorithmVersion !== `${address.namespace}:manifest:v1`
    || !fields(value, ["schemaVersion", "type", "ref", "payloadHash", "chunks"]) || value.schemaVersion !== 1
    || value.type !== "central_public_manifest" || value.ref !== address.ref || typeof value.payloadHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.payloadHash) || !list(value.chunks, 1, CENTRAL_PUBLIC_CHUNKS.chunks)
    || !value.chunks.every(identity) || new Set(value.chunks).size !== value.chunks.length
    || canonicalJson(value) !== committed.payloadJson) return fail("central_public_chunk_corrupt");

  const parts: string[] = [];

  for (const [index, id] of value.chunks.entries()) {
    const fact = facts.find(row => row.id === id), chunk = fact === undefined ? undefined : parse(fact.payloadJson);
    if (fact === undefined || !isRewardV2Fact(fact) || fact.scope !== address.scope || fact.kind !== "projection"
      || fact.algorithmVersion !== `${address.namespace}:chunk:v1` || fact.sequence >= committed.sequence
      || !fields(chunk, ["schemaVersion", "type", "ref", "payloadHash", "index", "text"]) || chunk.schemaVersion !== 1
      || chunk.type !== "central_public_fragment" || chunk.ref !== address.ref || chunk.payloadHash !== value.payloadHash || chunk.index !== index
      || typeof chunk.text !== "string" || chunk.text.length < 1 || chunk.text.length > CENTRAL_PUBLIC_CHUNKS.chunkChars
      || id !== chunkId(address, value.payloadHash, index, chunk.text) || canonicalJson(chunk) !== fact.payloadJson) {
      return fail("central_public_chunk_corrupt");
    }

    parts.push(chunk.text);
  }

  const payload = parts.join("");
  if (payload.length > CENTRAL_PUBLIC_CHUNKS.payloadChars || sha256Hex(payload) !== value.payloadHash) return fail("central_public_chunk_corrupt");

  return payload;
}
