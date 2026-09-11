// Trylo Desktop — Work `.trylo/out` scanner (P2-1, spec §8.4 / C-Edge P2-3).
//
// The one recursive scan of a project's output directory, bounded through the
// HostAdapter's `scanTree` (a single typed IPC from Rust). It carries no React
// state and no Tauri import — the HostAdapter is the only IPC boundary. It
// turns `FileStat[]` into the Work-neutral `ScannedArtifact` shape the scoped
// `WorkArtifactStore` compares at run start / final.
//
// **Filesystem eligibility invariant.** Only an entry with
// `isFile === true` is eligible to become an artifact. This single rule
// covers every non-regular entry the scan can surface:
//   - directories (`isDirectory === true, isFile === false`)
//   - symlinks / reparse points (`isSymlink === true, isFile === false`)
//   - sockets / FIFOs / device nodes / unknown special entries
//     (`isFile === false`)
// The previous implementation only excluded directories; symlinks and
// reparse points silently passed through and could become artifacts. We
// never follow a symlink as a "fix" — that would let a project bypass the
// scan root and surface arbitrary user content as a deliverable.

import { hostAdapter, type FilePath } from '../host-adapter';
import {
  artifactDisplayName,
  detectArtifactKind,
  relativeArtifactPath,
  type ArtifactKind,
} from '@trylo/work';
import type { ScannedArtifact, WorkArtifactKind } from '@trylo/work';
import type { FileStat } from '../host-adapter/types';

export interface WorkScanOptions {
  readonly maxFiles?: number;
  readonly maxDepth?: number;
}

export interface WorkScanOutcome {
  readonly artifacts: readonly ScannedArtifact[];
  readonly truncated: boolean;
  readonly warning?: string;
}

/** Files the daemon itself writes (its own logs / bookkeeping) and that are
 *  never user deliverables — skipped by the scan (spec §8.4 / old App guard). */
function isLoopInternal(name: string): boolean {
  return name.startsWith('loop-trylo-');
}

/** Defense in depth: the scan is rooted at `.trylo/out`, but if the host
 *  ever returns an entry outside that root (misconfiguration, host
 *  change) we still refuse to treat it as an artifact. The path is
 *  normalised so `\`-vs-`/` mismatches can't smuggle a bad entry. */
function isUnderOutRoot(absolutePath: string, outRoot: string): boolean {
  const norm = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = norm(absolutePath);
  const root = norm(outRoot);
  if (root === '') return true; // no root supplied (legacy / tests); allow
  return path === root || path.startsWith(root + '/');
}

function toScanned(file: FileStat, projectRoot: string): ScannedArtifact | undefined {
  const rel = relativeArtifactPath(file.path, projectRoot);
  if (rel === undefined || rel.length === 0) return undefined;
  return {
    target: { kind: 'file', relativePath: rel },
    id: rel,
    displayName: artifactDisplayName(file.path) || rel.split('/').pop() || rel,
    artifactKind: (detectArtifactKind(file.path) as WorkArtifactKind) ?? 'file',
    absolutePath: file.path,
    signature: { size: file.size, modifiedMs: file.modifiedMs },
  };
}

/** Scan `root/.trylo/out` recursively (bounded). A missing output dir is an
 *  empty scan, not a failure (spec §8.4). */
export async function scanWorkOutput(
  projectRoot: FilePath,
  options?: WorkScanOptions,
): Promise<WorkScanOutcome> {
  const root = projectRoot.replace(/[\\/]+$/, '');
  const outRoot: FilePath = `${root}/.trylo/out`;
  let scan;
  try {
    scan = await hostAdapter.fs.scanTree(outRoot, {
      maxFiles: options?.maxFiles ?? 1000,
      maxDepth: options?.maxDepth ?? 12,
    });
  } catch (err) {
    // The output dir may not exist yet (an empty project) → empty scan; a
    // genuine host failure gets surfaced as a warning but never throws.
    return {
      artifacts: [],
      truncated: false,
      warning: err instanceof Error ? err.message : String(err),
    };
  }

  const artifacts: ScannedArtifact[] = [];
  for (const file of scan.files) {
    // Filesystem eligibility invariant: only a true regular file passes.
    // Replaces the previous `if (file.isDirectory) continue;` which let
    // symlinks, reparse points, and special entries become artifacts.
    if (!file.isFile) continue;
    const name = file.path.split(/[\\/]/).pop() ?? '';
    if (isLoopInternal(name)) continue;
    // Defense in depth: never promote an attachment-staging path.
    if (file.path.includes('.trylo/attachments')) continue;
    // Defense in depth: host must scan only the OUT root.
    if (!isUnderOutRoot(file.path, outRoot)) continue;
    const artifact = toScanned(file, projectRoot);
    if (artifact) artifacts.push(artifact);
  }
  return {
    artifacts,
    truncated: scan.truncated,
    ...(scan.warnings.length > 0 ? { warning: scan.warnings[0] } : {}),
  };
}

/** Pure helper: resolve a scanned file into a neutral artifact, exported for
 *  unit tests without touching `hostAdapter`. The caller is responsible for
 *  the eligibility invariant (isFile === true, not a symlink, under OUT);
 *  the function only does the stat → artifact projection. */
export function artifactFromStat(
  file: Omit<FileStat, 'isDirectory' | 'isFile' | 'isSymlink' | 'path'> & { path: string },
  projectRoot: string,
): ScannedArtifact | undefined {
  return toScanned(file as FileStat, projectRoot);
}

export type { ArtifactKind };