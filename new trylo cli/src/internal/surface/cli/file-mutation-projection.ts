import type { CliFileMutation } from "../../protocol/cli-stream.js";

const FILE_TOOLS = new Set(["edit_file", "write_file", "apply_patch", "notebook_edit"]);
const MODES = ["created", "overwritten", "patched", "deleted", "moved"] as const;
const MAX_PREVIEW_CHARS = 64_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function path(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function mode(value: unknown): CliFileMutation["kind"] | undefined {
  return MODES.find(candidate => candidate === value);
}

/** Select only already-committed facts. Arbitrary result values never cross. */
export function projectFileMutations(name: string, value: unknown): ReadonlyArray<CliFileMutation> | undefined {
  const result = record(value);
  if (!FILE_TOOLS.has(name) || result === undefined) return undefined;

  const batch = Array.isArray(result.applied) ? result.applied : undefined;
  if (batch === undefined && record(result.fileWrite)?.kind !== "file_write") return undefined;

  const entries = batch ?? [{ ...record(result.fileWrite), preview: result.preview }];
  const out: CliFileMutation[] = [];
  let remaining = MAX_PREVIEW_CHARS;

  for (const raw of entries.slice(0, 64)) {
    const item = record(raw);
    if (item === undefined || !path(item.path)) continue;

    const kind = batch === undefined ? mode(item.mode)
      : item.op === "added" ? mode(item.mode)
        : item.op === "updated" ? "patched"
          : item.op === "deleted" ? "deleted" : item.op === "moved" ? "moved" : undefined;
    if (kind === undefined) continue;

    // An Add-overwrite preview contains only '+' lines in the current producer;
    // it cannot prove what was removed. Keep its mode, never call it a diff.
    const preview = kind !== "overwritten" && typeof item.preview === "string" ? item.preview : undefined;
    const kept = preview?.slice(0, remaining);

    remaining -= kept?.length ?? 0;
    out.push({ path: item.path, kind,
      ...(kind === "moved" && path(item.from) ? { from: item.from } : {}),
      ...(kept === undefined || kept === "" ? {} : { preview: kept }),
      ...(preview !== undefined && (kept !== preview || preview.includes("[preview truncated:")) ? { truncated: true } : {}),
    });
  }

  return out.length === 0 ? undefined : out;
}
