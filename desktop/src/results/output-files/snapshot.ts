import { hostAdapter } from '../../host-adapter';
import type { FsCommands } from '../../host-adapter/commands';
import type { StoredFileSignature } from '../conversation-result-types';
import { isOutputArtifactPath, OUTPUT_EXCLUDED_DIRECTORIES } from './eligibility';

export interface OutputFile {
  readonly path: string;
  readonly signature: StoredFileSignature;
}
export interface OutputSnapshot {
  readonly files: readonly OutputFile[];
  readonly incomplete: boolean;
}
export type OutputSnapshotFn = (root: string) => Promise<OutputSnapshot>;

/** Validate workspace containment before applying shared output eligibility. */
export function outputRelativePath(root: string, path: string): string | null {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
  const base = normalize(root).replace(/\/+$/, '');
  const absolute = normalize(path);
  const windows = /^[a-z]:/i.test(base) || base.startsWith('//');
  if (!(windows ? absolute.toLowerCase().startsWith(`${base.toLowerCase()}/`) : absolute.startsWith(`${base}/`))) return null;
  const relative = absolute.slice(base.length + 1);
  if (!relative || relative.split('/').some((part) => part === '.' || part === '..' || !part)) return null;
  return isOutputArtifactPath(relative) ? relative : null;
}

export async function snapshotOutputFiles(root: string, fs: Pick<FsCommands, 'scanTree'> = hostAdapter.fs): Promise<OutputSnapshot> {
  // Ownership is independent of format support. New source extensions,
  // extensionless build files and new media formats must not disappear.
  const scan = await fs.scanTree(root, { maxFiles: 10_000, maxDepth: 24, excludeDirs: OUTPUT_EXCLUDED_DIRECTORIES });
  const files = scan.files.flatMap((file): OutputFile[] => {
    if (!file.isFile || file.isSymlink || file.isDirectory) return [];
    const path = outputRelativePath(root, file.path);
    return path ? [{ path, signature: { size: file.size, modifiedMs: file.modifiedMs } }] : [];
  });
  return { files, incomplete: scan.truncated || scan.warnings.length > 0 };
}

/** Failures/timeouts are unknown baselines, never empty baselines. */
export async function boundedOutputSnapshot(scan: OutputSnapshotFn, root: string, budgetMs: number): Promise<OutputSnapshot | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([scan(root), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); })]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}
