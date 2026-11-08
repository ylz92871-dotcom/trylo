import { contentHashOf } from "../../../../../control/hash.js";
import type { ToolEvolutionRequest } from "./contracts.js";
import { isJsonValue, jsonBytes, keysAre, recordOf } from "./parse.js";

export const TOOL_PARENT_SOURCE_PAGE_CHARS = 4_000;
export const TOOL_PARENT_SOURCE_MAX_READS = 8;

export type ToolParentSourceRead = { readonly action: "read_parent"; readonly baseContentHash: string; readonly offset: number; readonly limit?: number };

export type ToolParentSourcePage = { readonly baseContentHash: string; readonly sourceChars: number; readonly offset: number;
  readonly text: string; readonly nextOffset?: number };

export type ToolParentSourceView = { readonly pages: readonly ToolParentSourcePage[]; readonly boundary:
  { readonly kind: "open" } | { readonly kind: "candidate_only"; readonly reason: "reserved_call" | "no_new_source" | "read_limit" } };

export function decodeToolParentSourceRead(raw: unknown): ToolParentSourceRead | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || jsonBytes(raw) > 2048 || !keysAre(raw, ["action", "baseContentHash", "offset"], ["limit"])
    || raw.action !== "read_parent" || typeof raw.baseContentHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.baseContentHash)
    || typeof raw.offset !== "number" || !Number.isSafeInteger(raw.offset) || raw.offset < 0
    || (raw.limit !== undefined && (typeof raw.limit !== "number" || !Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > TOOL_PARENT_SOURCE_PAGE_CHARS))) return undefined;
  return { action: "read_parent", baseContentHash: raw.baseContentHash, offset: raw.offset, ...(raw.limit === undefined ? {} : { limit: raw.limit }) };
}

/** A pure read of the already frozen parent, never a filesystem or tool capability. */
export function readToolParentSourcePage(prior: ToolEvolutionRequest["prior"], request: ToolParentSourceRead):
  { readonly ok: true; readonly page: ToolParentSourcePage } | { readonly ok: false; readonly code: string; readonly message: string } {
  const read = decodeToolParentSourceRead(request);

  if (prior === undefined) return { ok: false, code: "parent_source_unavailable", message: "This request has no frozen parent source" };

  if (read === undefined) return { ok: false, code: "invalid_parent_source_read", message: "Use exact hash, character offset and a bounded page limit" };

  const hash = contentHashOf(prior.source);
  if (read.baseContentHash !== hash) return { ok: false, code: "parent_source_hash_mismatch", message: "Read only the exact source hash supplied by this host" };

  if (read.offset > prior.source.length) return { ok: false, code: "parent_source_range_invalid", message: "The requested character offset exceeds this frozen source" };

  const end = Math.min(prior.source.length, read.offset + (read.limit ?? TOOL_PARENT_SOURCE_PAGE_CHARS));

  return { ok: true, page: { baseContentHash: hash, sourceChars: prior.source.length, offset: read.offset,
    text: prior.source.slice(read.offset, end), ...(end < prior.source.length ? { nextOffset: end } : {}) } };
}
