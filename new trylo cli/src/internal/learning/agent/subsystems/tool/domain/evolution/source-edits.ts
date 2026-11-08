import { contentHashOf } from "../../../../../control/hash.js";
import { isDigest, isJsonValue, jsonBytes, keysAre, recordOf, utf8Bytes } from "./json-shape.js";

export type ToolSourcePatch = {
  readonly baseContentHash: string;
  readonly edits: readonly { readonly search: string; readonly replace: string }[];
};

export type ToolSourcePatchLimits = { readonly maxInputBytes: number; readonly maxOutputBytes: number };

export type ToolSourcePatchFailure = "invalid_source_patch" | "invalid_source_patch_limits" | "source_patch_input_too_large"
  | "source_patch_base_mismatch" | "source_patch_search_missing" | "source_patch_search_ambiguous" | "source_patch_output_too_large";

export type ToolSourcePatchResult = {
  readonly ok: true; readonly source: string; readonly baseContentHash: string; readonly resultContentHash: string;
} | { readonly ok: false; readonly code: ToolSourcePatchFailure; readonly message: string; readonly editIndex?: number };

const MAX_PATCH_BYTES = 256 * 1024;
const DEFAULT_LIMITS: ToolSourcePatchLimits = { maxInputBytes: 128 * 1024, maxOutputBytes: 64 * 1024 };

/** A bounded exact-edit language, not a diff parser, download or authorization.
 * The final complete source goes through the existing checker and immutable archive. */
export function decodeToolSourcePatch(raw: unknown): ToolSourcePatch | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || !keysAre(raw, ["baseContentHash", "edits"]) || !isDigest(raw.baseContentHash)
    || !Array.isArray(raw.edits) || raw.edits.length < 1 || raw.edits.length > 8) return undefined;

  const edits: ToolSourcePatch["edits"][number][] = [];

  for (const edit of raw.edits) {
    if (!recordOf(edit) || !keysAre(edit, ["search", "replace"]) || typeof edit.search !== "string" || edit.search.length === 0
      || typeof edit.replace !== "string" || edit.search.length > MAX_PATCH_BYTES || edit.replace.length > MAX_PATCH_BYTES) return undefined;
    edits.push({ search: edit.search, replace: edit.replace });
  }

  return jsonBytes(raw) > MAX_PATCH_BYTES ? undefined : { baseContentHash: raw.baseContentHash, edits };
}

/** Hash the initial source once; anchors match the current text exactly once at
 * each step. Intermediate results also obey the output bound. Failure returns no
 * partially applied source, and replacement text is never regex-interpreted. */
export function applyToolSourcePatch(baseSource: string, raw: unknown, limits: ToolSourcePatchLimits = DEFAULT_LIMITS): ToolSourcePatchResult {
  if (![limits.maxInputBytes, limits.maxOutputBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    return failure("invalid_source_patch_limits", "source patch budgets must be positive safe integers");
  }

  if (typeof baseSource !== "string") return failure("invalid_source_patch", "source patch requires the host's exact prior source");

  if (baseSource.length > limits.maxInputBytes) return failure("source_patch_input_too_large", "base source exceeds the total input budget");

  const patch = decodeToolSourcePatch(raw);
  if (patch === undefined) return failure("invalid_source_patch", "source patch requires a base digest and one to eight bounded exact edits");

  const inputBytes = utf8Bytes(baseSource) + jsonBytes(patch);
  if (inputBytes > limits.maxInputBytes) return failure("source_patch_input_too_large", "base source plus serialized edits exceed the input budget");

  const baseContentHash = contentHashOf(baseSource);
  if (baseContentHash !== patch.baseContentHash) return failure("source_patch_base_mismatch", "the host's prior source does not match the initial source digest");

  let source = baseSource;

  for (const [editIndex, edit] of patch.edits.entries()) {
    const index = source.indexOf(edit.search);
    if (index < 0) return failure("source_patch_search_missing", "an exact anchor was not found; no fuzzy matching or line-ending normalization is performed", editIndex);

    if (source.indexOf(edit.search, index + 1) >= 0) return failure("source_patch_search_ambiguous", "an anchor has more than one exact occurrence", editIndex);

    const next = source.slice(0, index) + edit.replace + source.slice(index + edit.search.length);

    // Count the materialized result: splitting or joining UTF-16 surrogate pairs
    // makes byteLength(base)-byteLength(anchor)+byteLength(replacement) inexact.
    if (utf8Bytes(next) > limits.maxOutputBytes) return failure("source_patch_output_too_large", "an intermediate edited source exceeds the output budget", editIndex);

    source = next;
  }

  if (utf8Bytes(source) > limits.maxOutputBytes) return failure("source_patch_output_too_large", "the complete edited source exceeds the output budget");

  return { ok: true, source, baseContentHash, resultContentHash: contentHashOf(source) };
}

function failure(code: ToolSourcePatchFailure, message: string, editIndex?: number): Extract<ToolSourcePatchResult, { readonly ok: false }> {
  return { ok: false, code, message, ...(editIndex === undefined ? {} : { editIndex }) };
}
