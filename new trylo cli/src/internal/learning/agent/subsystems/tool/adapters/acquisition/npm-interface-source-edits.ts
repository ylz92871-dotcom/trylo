import { contentHashOf } from "../../../../../control/hash.js";
import { isDigest, isJsonValue, jsonBytes, keysAre, recordOf } from "../../domain/evolution/json-shape.js";
import { applyToolSourcePatch, decodeToolSourcePatch } from "../../domain/evolution/source-edits.js";
import { isNpmSourcePatchPath, NPM_SOURCE_PATCH_MAX_BYTES, NPM_SOURCE_PATCH_TOTAL_BYTES, type NpmSourcePatch } from "../../domain/evolution/npm-adaptation.js";
import { decodeNpmToolInterface } from "../../domain/evolution/npm-production-plan.js";
import { pipelineFailure, type PipelineFailure } from "../../runtime/pipeline-assets.js";
import type { PackageFile } from "./ustar-reader.js";
import { sha256Bytes } from "./npm-package-check.js";

/** Compact model edits become the original complete-source ABI before plan
 * decoding, checking or archive. The host supplies the verified original files
 * and allowed prior/failed adapter bases; no model field selects a new source. */
export function resolveNpmInterfaceSourceEdits(raw: unknown, files: readonly PackageFile[], adapterBases: readonly string[]): PipelineFailure | {
  readonly ok: true; readonly interface: unknown;
} {
  if (!isJsonValue(raw) || !recordOf(raw) || jsonBytes(raw) > 768 * 1024 || !keysAre(raw, ["descriptor", "runtime"], ["patches"])) {
    return pipelineFailure("npm_interface_invalid", "an interface must be bounded descriptor/runtime/patch data without extra authority fields");
  }

  const runtime = resolveAdapter(raw.runtime, adapterBases);
  if (!runtime.ok) return runtime;

  let patches: readonly NpmSourcePatch[] | undefined;
  if (raw.patches !== undefined) {
    if (!Array.isArray(raw.patches) || raw.patches.length < 1 || raw.patches.length > 16) return pipelineFailure("npm_patch_invalid", "patches must identify one to sixteen indexed source files");

    const normalized: NpmSourcePatch[] = [], paths = new Set<string>();

    for (const row of raw.patches) {
      const patch = resolveFilePatch(row, files);
      if (!patch.ok) return patch;
      if (paths.has(patch.patch.path.toLowerCase())) return pipelineFailure("npm_patch_path_ambiguous", "each source path can appear only once; use sequential edits inside that file");
      paths.add(patch.patch.path.toLowerCase());
      normalized.push(patch.patch);
    }

    patches = normalized;

    if (jsonBytes(patches) > NPM_SOURCE_PATCH_TOTAL_BYTES) return pipelineFailure("npm_patch_total_too_large", "complete file overlays exceed the existing bounded package adaptation budget");
  }

  const canonical = decodeNpmToolInterface({ descriptor: raw.descriptor, runtime: runtime.runtime, ...(patches === undefined ? {} : { patches }) });

  return canonical === undefined ? pipelineFailure("npm_interface_invalid", "the normalized source still must satisfy the original descriptor, profile and patch ABI")
    : { ok: true, interface: canonical };
}

function resolveAdapter(raw: unknown, adapterBases: readonly string[]): PipelineFailure | { readonly ok: true; readonly runtime: unknown } {
  if (!recordOf(raw) || raw.profile !== "confined_npm_library_v1" || !Object.hasOwn(raw, "sourcePatch")) return { ok: true, runtime: raw };

  if (!keysAre(raw, ["profile", "sourcePatch"])) return pipelineFailure("npm_adapter_patch_invalid", "adapter source and sourcePatch are mutually exclusive and cannot carry additional runtime grants");

  const patch = decodeToolSourcePatch(raw.sourcePatch);
  if (patch === undefined) return pipelineFailure("npm_adapter_patch_invalid", "adapter edits require the host-provided base content hash and bounded exact edits");

  const base = adapterBases.find(source => contentHashOf(source) === patch.baseContentHash);
  if (base === undefined) return pipelineFailure("npm_adapter_patch_base_mismatch", "the requested adapter base is not an exact host-provided parent or recent failed implementation");

  const expanded = applyToolSourcePatch(base, patch, { maxInputBytes: 128 * 1024, maxOutputBytes: 64 * 1024 });

  return !expanded.ok ? pipelineFailure(expanded.code, expanded.message)
    : { ok: true, runtime: { profile: raw.profile, source: expanded.source } };
}

function resolveFilePatch(raw: unknown, files: readonly PackageFile[]): PipelineFailure | { readonly ok: true; readonly patch: NpmSourcePatch } {
  if (!recordOf(raw) || !isNpmSourcePatchPath(raw.path)) return pipelineFailure("npm_patch_path_invalid", "only existing indexed package JS source can be edited; license and metadata paths are excluded");

  if (!isDigest(raw.oldSha256)) return pipelineFailure("npm_patch_hash_missing", "copy the original file's host-indexed SHA-256 into oldSha256");

  const edited = Object.hasOwn(raw, "edits");
  if (edited === Object.hasOwn(raw, "source") || !keysAre(raw, edited ? ["path", "oldSha256", "edits"] : ["path", "oldSha256", "source"])) {
    return pipelineFailure("npm_patch_invalid", "a file patch must contain either complete source or exact edits, never both");
  }

  const matches = files.filter(file => file.path === raw.path);
  if (matches.length !== 1) return pipelineFailure("npm_patch_source_missing", "the exact source file is absent or ambiguous in the host's original reviewed index");

  const file = matches[0]!;
  if (sha256Bytes(file.body) !== raw.oldSha256) return pipelineFailure("npm_patch_source_mismatch", "oldSha256 does not match the original reviewed file bytes");

  if (!edited) return typeof raw.source === "string" ? { ok: true, patch: { path: raw.path, oldSha256: raw.oldSha256, source: raw.source } }
    : pipelineFailure("npm_patch_invalid", "complete file source must be a string");

  let source: string;

  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.body); }
  catch { return pipelineFailure("npm_patch_source_encoding_invalid", "exact source edits require a valid UTF-8 original file"); }

  const expanded = applyToolSourcePatch(source, { baseContentHash: contentHashOf(source), edits: raw.edits }, {
    maxInputBytes: 512 * 1024, maxOutputBytes: NPM_SOURCE_PATCH_MAX_BYTES,
  });

  return !expanded.ok ? pipelineFailure(expanded.code, expanded.message)
    : { ok: true, patch: { path: raw.path, oldSha256: raw.oldSha256, source: expanded.source } };
}
