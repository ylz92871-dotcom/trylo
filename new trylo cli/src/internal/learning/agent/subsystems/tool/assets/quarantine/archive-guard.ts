import { err, ok, type Result } from "../../../../../../tooling/contract/result.js";

export type ArchiveEntryKind = "file" | "directory" | "symlink";

export type ArchiveEntry = {
  readonly path: string;
  readonly kind: ArchiveEntryKind;
  readonly size: number;
  readonly content?: string;
  readonly linkTarget?: string;
  readonly executable?: boolean;
  readonly postinstall?: boolean;
  readonly downloader?: boolean;
};

export type ArchiveFixture = {
  readonly name: string;
  readonly expectedHash: string;
  readonly actualHash: string;
  readonly entries: readonly ArchiveEntry[];
  readonly uncompressedBytes: number;
};

export type ArchiveFailure =
  | "hash_mismatch"
  | "path_traversal"
  | "symlink_escape"
  | "zip_bomb"
  | "postinstall_forbidden"
  | "downloader_forbidden";

const ZIP_BOMB_RATIO = 100;
const ZIP_BOMB_BYTES = 10_000_000;

function isTraversal(entryPath: string): boolean {
  const normalized = entryPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return true;
  }
  const parts = normalized.split("/");
  return parts.includes("..");
}

function symlinkEscapes(target: string): boolean {
  const normalized = target.replaceAll("\\", "/");
  return normalized.startsWith("/") || normalized.includes("..") || /^[a-zA-Z]:/.test(normalized);
}

export function inspectArchive(
  archive: ArchiveFixture,
  compressedBytes: number,
): Result<readonly ArchiveEntry[], ArchiveFailure> {
  if (archive.expectedHash !== archive.actualHash) {
    return err("hash_mismatch", "archive content hash mismatch");
  }

  if (
    archive.uncompressedBytes > ZIP_BOMB_BYTES ||
    (compressedBytes > 0 && archive.uncompressedBytes / compressedBytes > ZIP_BOMB_RATIO)
  ) {
    return err("zip_bomb", "archive expansion exceeds zip-bomb limits");
  }

  for (const entry of archive.entries) {
    if (isTraversal(entry.path)) {
      return err("path_traversal", `refusing path ${entry.path}`);
    }

    if (entry.kind === "symlink") {
      const target = entry.linkTarget ?? "";
      if (symlinkEscapes(target)) {
        return err("symlink_escape", `symlink ${entry.path} escapes quarantine`);
      }
    }

    if (entry.postinstall === true) {
      return err("postinstall_forbidden", "postinstall is forbidden by default");
    }

    if (entry.downloader === true) {
      return err("downloader_forbidden", "downloaders cannot bypass quarantine audit");
    }
  }

  return ok(archive.entries);
}
