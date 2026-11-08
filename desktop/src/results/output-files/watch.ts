import { hostAdapter } from '../../host-adapter';
import { isTauri } from '../../host-adapter/tauri-detect';
import type { WorkspaceWatcher } from '../../host-adapter/workspace-watcher';
import type { FsCommands } from '../../host-adapter/commands';
import type { StoredProducedFile } from '../conversation-result-types';
import { outputRelativePath } from './snapshot';
import type { OutputDelta } from './delta';

export interface OutputWatch {
  readonly ready: Promise<void>;
  finish(): Promise<OutputDelta>;
  close(): void;
}
export type OutputWatchFactory = (root: string) => OutputWatch | undefined;

/** A run's live filesystem evidence complements bounded snapshots in large
 * repositories. Uses the shared host watcher, never assistant prose/stdout. */
export function watchOutputFiles(root: string, watcher: WorkspaceWatcher, fs: Pick<FsCommands, 'statFile'>): OutputWatch {
  const handle = watcher.watch(root);
  const changed = new Map<string, 'created' | 'updated'>();
  let incomplete = false;
  let closed = false;
  let finished: Promise<OutputDelta> | undefined;
  const unsubscribe = handle.onDidChangeFile(root, (events) => {
    for (const event of events) {
      if (event.kind === 'rescan') { incomplete = true; continue; }
      const path = outputRelativePath(root, event.path);
      if (!path) continue;
      if (event.kind === 'deleted') { changed.delete(path); continue; }
      if (!changed.has(path) && changed.size >= 1000) { incomplete = true; continue; }
      changed.set(path, event.kind === 'created' || changed.get(path) === 'created' ? 'created' : 'updated');
    }
  });
  let readyTimer: ReturnType<typeof setTimeout>;
  const ready = Promise.race([
    handle.ready ?? Promise.resolve(),
    new Promise<never>((_resolve, reject) => { readyTimer = setTimeout(() => reject(new Error('watch readiness timeout')), 500); }),
  ]).catch(() => { incomplete = true; }).finally(() => clearTimeout(readyTimer));
  const close = (): void => {
    if (closed) return;
    closed = true; unsubscribe(); void handle.close().catch(() => {});
  };
  const finish = (): Promise<OutputDelta> => {
    finished ??= (async () => {
      await ready;
      // Let the native notification channel drain its final write events.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const candidates = [...changed];
      const files: StoredProducedFile[] = [];
      let index = 0;
      const read = async (): Promise<void> => {
        while (!closed && index < candidates.length) {
          const [path, change] = candidates[index++]!;
          try {
            const stat = await fs.statFile(`${root.replace(/[\\/]+$/, '')}/${path}`);
            if (!closed && stat.isFile && !stat.isSymlink && !stat.isDirectory) files.push({ path, change, signature: { size: stat.size, modifiedMs: stat.modifiedMs } });
          } catch (error) { if (!/ENOENT|NotFound|not found|找不到/i.test(String(error))) incomplete = true; }
        }
      };
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([Promise.all(Array.from({ length: Math.min(16, candidates.length) }, read)), new Promise<void>((resolve) => { timer = setTimeout(() => { incomplete = true; resolve(); }, 2000); })]);
      } finally { clearTimeout(timer!); close(); }
      return { files: [...files], incomplete };
    })();
    return finished;
  };
  return { ready, finish, close };
}

export const createDesktopOutputWatch: OutputWatchFactory = (root) => isTauri() ? watchOutputFiles(root, hostAdapter.watcher, hostAdapter.fs) : undefined;

export function mergeOutputEvidence(snapshot: OutputDelta, watched: OutputDelta | undefined): OutputDelta {
  if (!watched) return snapshot;
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  for (const file of watched.files) files.set(file.path, { ...file, change: files.get(file.path)?.change ?? file.change });
  return { files: [...files.values()].sort((a, b) => b.signature.modifiedMs - a.signature.modifiedMs || a.path.localeCompare(b.path)), incomplete: watched.incomplete };
}
