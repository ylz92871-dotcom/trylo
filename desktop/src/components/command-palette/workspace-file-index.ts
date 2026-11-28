import { hostAdapter } from '../../host-adapter';

export interface WorkspaceFileEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly name: string;
}

const IGNORED_DIRS = new Set([
  '.git',
  '.trylo',
  'node_modules',
  'dist',
  'target',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'out',
  '__pycache__',
]);

const CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 400;

interface CacheEntry {
  readonly timestamp: number;
  readonly files: readonly WorkspaceFileEntry[];
}

const cache = new Map<string, CacheEntry>();

function normalizeRoot(root: string): string {
  return root.replace(/[\\/]+$/, '');
}

function toRelative(fullPath: string, normalizedRoot: string): string {
  const norm = fullPath.replace(/\\/g, '/');
  const rootNorm = normalizedRoot.replace(/\\/g, '/');
  if (norm.startsWith(`${rootNorm}/`)) {
    return norm.slice(rootNorm.length + 1);
  }
  return norm;
}

export function invalidateWorkspaceFileIndex(root?: string): void {
  if (root === undefined) {
    cache.clear();
    return;
  }
  cache.delete(normalizeRoot(root));
}

/**
 * Shallow, bounded workspace file scan built on hostAdapter.fs.listDir.
 * Safe in browser-only dev mode (returns empty array when Tauri FS is unavailable).
 */
export async function listWorkspaceFiles(
  root: string,
  options?: { readonly signal?: AbortSignal; readonly maxEntries?: number },
): Promise<readonly WorkspaceFileEntry[]> {
  const normalizedRoot = normalizeRoot(root);
  if (!normalizedRoot) return [];

  const cached = cache.get(normalizedRoot);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.files;
  }

  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const results: WorkspaceFileEntry[] = [];
  const queue: { readonly dir: string; readonly depth: number }[] = [
    { dir: normalizedRoot, depth: 0 },
  ];

  while (queue.length > 0 && results.length < maxEntries) {
    if (options?.signal?.aborted) return results;
    const current = queue.shift()!;
    let entries;
    try {
      entries = await hostAdapter.fs.listDir(current.dir);
    } catch {
      continue;
    }
    if (options?.signal?.aborted) return results;

    for (const entry of entries) {
      if (results.length >= maxEntries) break;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (entry.isDirectory) {
        if (!IGNORED_DIRS.has(entry.name) && current.depth + 1 < DEFAULT_MAX_DEPTH) {
          queue.push({ dir: entry.path, depth: current.depth + 1 });
        }
      } else {
        results.push({
          path: entry.path,
          relativePath: toRelative(entry.path, normalizedRoot),
          name: entry.name,
        });
      }
    }
  }

  if (!options?.signal?.aborted) {
    cache.set(normalizedRoot, { timestamp: Date.now(), files: results });
  }
  return results;
}
