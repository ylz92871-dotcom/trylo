import { createHash } from "node:crypto";
import {
  CHECKPOINT_FORMAT_VERSION,
  type CheckpointFileEntry,
  type CheckpointManifest,
} from "../../ports/checkpoint.js";

/**
 * Manifest serialization and its tamper check.
 *
 * The digest covers a canonical *string*, not a JSON object, because key order
 * in JSON is not part of its meaning yet is part of its bytes — an attacker (or
 * a careless rewrite) only has to reorder keys to break a naive comparison or,
 * worse, to make a different manifest hash identically. Canonicalizing first
 * removes that degree of freedom.
 *
 * Files are ordered by path before hashing, so the same directory always
 * produces the same digest regardless of how the filesystem enumerates it.
 */

export type ManifestBody = Omit<CheckpointManifest, "digest">;

export function sortEntries(
  files: readonly CheckpointFileEntry[],
): readonly CheckpointFileEntry[] {
  return [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function canonicalManifestBody(body: ManifestBody): string {
  const lines: string[] = [
    "trylo-checkpoint-manifest",
    `version=${body.formatVersion}`,
    `id=${body.checkpointId}`,
    `label=${body.label}`,
    `createdAt=${body.createdAt}`,
    `fileCount=${body.fileCount}`,
    `totalBytes=${body.totalBytes}`,
    `ignores=${[...body.ignores].sort().join(",")}`,
  ];

  for (const file of sortEntries(body.files)) {
    lines.push(`file=${file.path}\u0000${file.bytes}\u0000${file.sha256}`);
  }

  return lines.join("\n");
}

export function manifestDigest(body: ManifestBody): string {
  return createHash("sha256").update(canonicalManifestBody(body), "utf8").digest("hex");
}

export function sealManifest(body: ManifestBody): CheckpointManifest {
  return { ...body, digest: manifestDigest(body) };
}

export function serializeManifest(manifest: CheckpointManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export type ParsedManifest =
  | { readonly ok: true; readonly manifest: CheckpointManifest }
  | {
      readonly ok: false;
      readonly code: "manifest_malformed" | "checksum_mismatch";
      readonly detail: string;
    };

/**
 * Parses then *re-derives* the digest. Reading a manifest whose digest was
 * recomputed over edited content is therefore impossible: recomputation has to
 * happen before this returns, and it either matches the stored value or nobody
 * acts on the file.
 */
export function parseManifest(text: string): ParsedManifest {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "manifest_malformed", detail: "not json" };
  }

  if (!isManifestShape(raw)) {
    return { ok: false, code: "manifest_malformed", detail: "unexpected shape" };
  }

  const { digest, ...body } = raw;

  if (manifestDigest(body) !== digest) {
    return { ok: false, code: "checksum_mismatch", detail: body.checkpointId };
  }

  return { ok: true, manifest: raw };
}

function isManifestShape(value: unknown): value is CheckpointManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const shape = value as Record<string, unknown>;
  if (shape.formatVersion !== CHECKPOINT_FORMAT_VERSION) {
    return false;
  }

  if (
    typeof shape.checkpointId !== "string" ||
    typeof shape.label !== "string" ||
    typeof shape.createdAt !== "string" ||
    typeof shape.digest !== "string" ||
    typeof shape.fileCount !== "number" ||
    typeof shape.totalBytes !== "number" ||
    !Array.isArray(shape.ignores) ||
    !Array.isArray(shape.files)
  ) {
    return false;
  }

  return shape.files.every((file) => isEntryShape(file));
}

function isEntryShape(value: unknown): value is CheckpointFileEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const shape = value as Record<string, unknown>;

  return (
    typeof shape.path === "string" &&
    typeof shape.bytes === "number" &&
    typeof shape.sha256 === "string"
  );
}
