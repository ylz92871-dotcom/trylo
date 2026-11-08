import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { CheckpointManifest, CheckpointResult, RestoreOutcome } from "../../ports/checkpoint.js";
import { parseManifest } from "./manifest.js";
import { ignoreSet, listWorkspaceFiles } from "./walk.js";
import {
  failureOf,
  filesDirectory,
  manifestPathOf,
  nativeJoin,
  sha256Of,
  type StorePaths,
  writeAtomic,
} from "./support.js";

/**
 * Restoring a workspace from a snapshot.
 *
 * Verify everything, then apply. Two phases, in this order, because a failed
 * verification must leave the workspace byte-for-byte as it was — which is only
 * true if no file has been written yet.
 *
 * Within the apply phase, replacing comes before removing. An interruption during
 * replacement leaves the tree closer to the checkpoint; removing first would
 * leave it further away. Either way the caller gets a failure code, and simply
 * restoring again converges — which is why an interrupted restore is reported as
 * `restore_interrupted` rather than papered over as partial success.
 */

export function applyRestore(input: {
  readonly paths: StorePaths;
  readonly workspaceRoot: string;
  readonly checkpointId: string;
  readonly ignoredNames: readonly string[];
}): CheckpointResult<RestoreOutcome> {
  const manifestPath = manifestPathOf(input.paths, input.checkpointId);
  if (!existsSync(manifestPath)) {
    return failureOf("checkpoint_not_found", input.checkpointId);
  }

  let text: string;

  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (error) {
    return failureOf("manifest_unreadable", String(error));
  }

  const parsed = parseManifest(text);
  if (!parsed.ok) {
    return failureOf(parsed.code, parsed.detail);
  }

  const manifest = parsed.manifest;
  if (manifest.checkpointId !== input.checkpointId) {
    return failureOf("checkpoint_not_found", `${input.checkpointId} != ${manifest.checkpointId}`);
  }

  const filesRoot = filesDirectory(input.paths, input.checkpointId);
  const verified = verifyStored(manifest, filesRoot);
  if (!verified.ok) {
    return failureOf(verified.code, verified.detail);
  }

  try {
    replaceFiles(manifest, filesRoot, input.workspaceRoot);
    const strays = strayFiles(input.workspaceRoot, manifest, input.ignoredNames);
    for (const stray of strays) {
      rmSync(stray, { force: true });
    }
    return { ok: true, value: { restoredFiles: manifest.files.length, removedFiles: strays.length } };
  } catch (error) {
    return failureOf("restore_interrupted", String(error));
  }
}

function verifyStored(
  manifest: CheckpointManifest,
  filesRoot: string,
): { ok: true } | { ok: false; code: "checksum_mismatch" | "checkpoint_not_found"; detail: string } {
  for (const entry of manifest.files) {
    const source = nativeJoin(filesRoot, entry.path);

    try {
      statSync(source);
    } catch {
      return { ok: false, code: "checkpoint_not_found", detail: entry.path };
    }

    let actual: string;

    try {
      actual = sha256Of(source);
    } catch (error) {
      return { ok: false, code: "checksum_mismatch", detail: `${entry.path}: ${String(error)}` };
    }

    if (actual !== entry.sha256) {
      return { ok: false, code: "checksum_mismatch", detail: entry.path };
    }
  }
  return { ok: true };
}

function replaceFiles(manifest: CheckpointManifest, filesRoot: string, workspaceRoot: string): void {
  for (const entry of manifest.files) {
    const destination = nativeJoin(workspaceRoot, entry.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeAtomic(destination, readFileSync(nativeJoin(filesRoot, entry.path)));
  }
}

/** Files present now that the snapshot does not know about. */
function strayFiles(
  workspaceRoot: string,
  manifest: CheckpointManifest,
  ignoredNames: readonly string[],
): readonly string[] {
  const known = new Set(manifest.files.map((entry) => entry.path));
  const walked = listWorkspaceFiles(workspaceRoot, ignoreSet(ignoredNames));
  if (!walked.ok) {
    return [];
  }
  return walked.files.filter((file) => !known.has(file.relativePath)).map((file) => file.absolutePath);
}
