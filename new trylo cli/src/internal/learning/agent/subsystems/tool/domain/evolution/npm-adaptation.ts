import { safePackagePath } from "../../../../../../tooling/contract/npm-source.js";
import { isJsonValue, jsonBytes, keysAre, recordOf, textOf } from "./parse.js";
import { utf8Bytes } from "./json-shape.js";

/** An overlay is versioned data. The installer remains the authority for original bytes. */
export type NpmSourcePatch = { readonly path: string; readonly oldSha256: string; readonly source: string };

export const NPM_LIBRARY_ENTRYPOINT = "__trylo_adapter__.cjs";
export const NPM_SOURCE_PATCH_MAX_BYTES = 256 * 1024;
export const NPM_SOURCE_PATCH_TOTAL_BYTES = 512 * 1024;

export function isNpmSourcePatchPath(path: unknown): path is string {
  return typeof path === "string" && safePackagePath(path) && path.startsWith("node_modules/") && /\.(?:js|cjs|mjs)$/.test(path)
    && !/(?:^|\/)(?:licen[sc]e|copying|notice)(?:[.-][^/]*)?$/i.test(path);
}

export function npmSourcePatches(raw: unknown): raw is readonly NpmSourcePatch[] {
  if (!isJsonValue(raw) || !Array.isArray(raw) || raw.length === 0 || raw.length > 16 || jsonBytes(raw) > NPM_SOURCE_PATCH_TOTAL_BYTES) return false;

  const paths = new Set<string>();

  for (const row of raw) {
    if (!recordOf(row) || !keysAre(row, ["path", "oldSha256", "source"]) || !isNpmSourcePatchPath(row.path)
      || typeof row.oldSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.oldSha256) || !textOf(row.source) || utf8Bytes(row.source) > NPM_SOURCE_PATCH_MAX_BYTES
      || row.source.includes("\0") || paths.has(row.path.toLowerCase())) return false;
    paths.add(row.path.toLowerCase());
  }

  return true;
}
