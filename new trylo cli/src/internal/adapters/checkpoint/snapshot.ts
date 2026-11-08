import { createReadStream, readdirSync } from "node:fs";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  CHECKPOINT_FORMAT_VERSION,
  type CheckpointFileEntry,
  type CheckpointResult,
  type SnapshotOutcome,
} from "../../ports/checkpoint.js";
import { sealManifest, serializeManifest, sortEntries } from "./manifest.js";
import type { WalkedFile } from "./walk.js";
import { failureOf, filesDirectory, type StorePaths, manifestPathOf, nativeJoin } from "./support.js";

/**
 * Taking a snapshot.
 *
 * Order matters and is asserted by tests: every input is proven before any file
 * is copied, and the manifest is written last. A snapshot without its manifest
 * would be a directory of files nobody can verify or safely apply.
 */

export async function takeSnapshot(input: {
  readonly signal?: AbortSignal;
  readonly paths: StorePaths;
  readonly label: string;
  readonly createdAt: string;
  readonly files: readonly WalkedFile[];
  readonly ignoredNames: readonly string[];
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}): Promise<CheckpointResult<SnapshotOutcome>> {
  const oversized = describeOverflow(input.files, input.maxFiles, input.maxTotalBytes);
  if (oversized !== undefined) {
    return failureOf("size_limit_exceeded", oversized);
  }
  const reserved = await reserveCheckpoint(input.paths, input.label, input.signal);
  return reserved.ok ? writeSnapshot({ ...input, checkpointId: reserved.value }) : reserved;
}

function describeOverflow(
  files: readonly WalkedFile[],
  maxFiles: number,
  maxTotalBytes: number,
): string | undefined {
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);

  if (files.length > maxFiles) {
    return `${files.length} files > ${maxFiles}`;
  }

  if (totalBytes > maxTotalBytes) {
    return `${totalBytes} bytes > ${maxTotalBytes}`;
  }

  return undefined;
}

/** Sequential and derived from what already exists: no clock, no randomness. */
export function nextCheckpointId(storageRoot: string, label: string): string {
  let count = 0;

  try {
    for (const entry of readdirSync(storageRoot, { withFileTypes: true })) {
      const number = entry.isDirectory() ? /^cp-(\d+)(?:-|$)/.exec(entry.name)?.[1] : undefined;
      if (number !== undefined) count = Math.max(count, Number(number));
    }
  } catch {
    count = 0;
  }

  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `cp-${String(count + 1).padStart(4, "0")}${slug.length > 0 ? `-${slug}` : ""}`;
}

/** Claim the directory atomically; concurrent preparations never share a copy tree. */
async function reserveCheckpoint(
  paths: StorePaths,
  label: string,
  signal?: AbortSignal,
): Promise<CheckpointResult<string>> {
  while (!signal?.aborted) {
    const checkpointId = nextCheckpointId(paths.storageRoot, label);
    try {
      await mkdir(paths.checkpointRoot(checkpointId));
      return { ok: true, value: checkpointId };
    } catch (error) {
      // A competing writer made progress. Inspect that new directory and select the next id.
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      return failureOf("storage_unavailable", String(error));
    }
  }
  return failureOf("snapshot_cancelled", "checkpoint preparation cancelled");
}

async function writeSnapshot(input: {
  readonly signal?: AbortSignal;
  readonly paths: StorePaths;
  readonly checkpointId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly files: readonly WalkedFile[];
  readonly ignoredNames: readonly string[];
  readonly maxTotalBytes: number;
}): Promise<CheckpointResult<SnapshotOutcome>> {
  const filesRoot = filesDirectory(input.paths, input.checkpointId);

  try {
    input.signal?.throwIfAborted();
    await mkdir(filesRoot, { recursive: true });
  } catch (error) {
    await discardSnapshot(input.paths.checkpointRoot(input.checkpointId));
    return failureOf(input.signal?.aborted ? "snapshot_cancelled" : "storage_unavailable", String(error));
  }

  const entries: CheckpointFileEntry[] = [];
  let totalBytes = 0;

  for (const file of input.files) {
    const stored = nativeJoin(filesRoot, file.relativePath);

    try {
      input.signal?.throwIfAborted();
      await mkdir(path.dirname(stored), { recursive: true });
      await copyFile(file.absolutePath, stored);
      input.signal?.throwIfAborted();
    } catch (error) {
      await discardSnapshot(input.paths.checkpointRoot(input.checkpointId));
      return failureOf(
        input.signal?.aborted ? "snapshot_cancelled" : "snapshot_interrupted",
        `${file.relativePath}: ${String(error)}`,
      );
    }

    let sha256: string;
    let copiedBytes = 0;

    try {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(stored, { signal: input.signal })) {
        hash.update(chunk);
        copiedBytes += Buffer.byteLength(chunk);
      }
      input.signal?.throwIfAborted();
      sha256 = hash.digest("hex");
    } catch (error) {
      await discardSnapshot(input.paths.checkpointRoot(input.checkpointId));
      return failureOf(
        input.signal?.aborted ? "snapshot_cancelled" : "snapshot_interrupted",
        `${file.relativePath}: ${String(error)}`,
      );
    }

    totalBytes += copiedBytes;
    if (totalBytes > input.maxTotalBytes) {
      await discardSnapshot(input.paths.checkpointRoot(input.checkpointId));
      return failureOf("size_limit_exceeded", `${totalBytes} copied bytes > ${input.maxTotalBytes}`);
    }
    // The copy can differ from the earlier enumeration while other tasks save.
    // Count the exact same stored byte stream whose checksum restore will verify.
    entries.push({ path: file.relativePath, bytes: copiedBytes, sha256 });
  }

  const manifest = sealManifest({
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    checkpointId: input.checkpointId,
    label: input.label,
    createdAt: input.createdAt,
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    ignores: input.ignoredNames,
    files: sortEntries(entries),
  });

  try {
    input.signal?.throwIfAborted();
    const target = manifestPathOf(input.paths, input.checkpointId),
      temporary = target + ".trylo-partial";
    await writeFile(temporary, serializeManifest(manifest));
    input.signal?.throwIfAborted();
    await rename(temporary, target);
  } catch (error) {
    await discardSnapshot(input.paths.checkpointRoot(input.checkpointId));
    return failureOf(input.signal?.aborted ? "snapshot_cancelled" : "snapshot_interrupted", String(error));
  }

  return { ok: true, value: { checkpointId: input.checkpointId, manifest } };
}

async function discardSnapshot(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    /* The typed failure remains authoritative; an incomplete directory is not a valid checkpoint. */
  }
}
