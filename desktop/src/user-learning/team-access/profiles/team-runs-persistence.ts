import { parseTeamRunsFile, serializeTeamRunsFile, type PersistableTeamRun } from '../persist';

export interface TeamRunsStorage {
  load(workspaceRoot: string): Promise<string | null>;
  save(workspaceRoot: string, expected: string | null, json: string): Promise<
    { readonly status: 'written' } | { readonly status: 'conflict'; readonly current: string | null }>;
}
export interface TeamRunMutation {
  readonly version: number;
  readonly run: PersistableTeamRun;
  /** Absence reconciliation may only close the snapshot it actually inspected. */
  readonly onlyIfUnchanged?: PersistableTeamRun;
}
export function sameTeamRun(a: PersistableTeamRun | undefined, b: PersistableTeamRun | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function readRuns(raw: string | null): readonly PersistableTeamRun[] {
  if (raw === null) return [];
  const parsed = parseTeamRunsFile(raw);
  if (!parsed) throw new Error('另一窗口的团队历史无法解析，已保留原文件。');
  return parsed.runs;
}

/** Merge only local mutations into the exact CAS snapshot, never a stale full cache. */
export async function commitTeamRuns(storage: TeamRunsStorage, workspaceRoot: string, workspaceId: string,
  initial: string | null, mutations: readonly TeamRunMutation[], isCurrent: () => boolean) {
  let expected = initial;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!isCurrent()) return null;
    const merged = new Map(readRuns(expected).map(run => [run.id, run]));
    for (const mutation of mutations) {
      if (mutation.onlyIfUnchanged && !sameTeamRun(merged.get(mutation.run.id), mutation.onlyIfUnchanged)) continue;
      merged.set(mutation.run.id, mutation.run);
    }
    const json = serializeTeamRunsFile(workspaceId, [...merged.values()]);
    const candidateRuns = readRuns(json); // Validate before any durable replacement.
    const reply = await storage.save(workspaceRoot, expected, json);
    if (reply.status === 'written') return { raw: json, runs: candidateRuns };
    if (reply.status !== 'conflict' || reply.current !== null && typeof reply.current !== 'string') {
      throw new Error('原生团队历史保存回执无效，未确认写入。');
    }
    expected = reply.current;
  }
  throw new Error('其他窗口正在更新团队历史，本次记录保留在内存中，等待下次保存重试。');
}
