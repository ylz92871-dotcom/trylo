import { runCliCommand, type CliCommandInput } from '../host-adapter/cli-command';
import { record, text } from './wire';

export type ToolJobState = 'queued' | 'running' | 'waiting_approval' | 'waiting_evidence' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
export type ToolLearningJobView = {
  readonly jobId: string;
  readonly state: ToolJobState;
  readonly attempt: number;
  readonly capability: string;
  readonly createdAt: string;
  readonly action: string;
  readonly outcomeCode?: string;
  readonly candidateVersionId?: string;
  readonly searchStatus?: 'complete' | 'partial' | 'failed';
  readonly discovered?: number;
};
export type ToolLearningStatus = { readonly formatVersion: 1; readonly workspaceId: string; readonly jobs: readonly ToolLearningJobView[]; readonly totalJobs: number; readonly truncated: boolean };
export type ToolLearningLoad = { readonly ok: true; readonly status: ToolLearningStatus } | { readonly ok: false; readonly reason: string };
export type ToolLearningRuntime = Pick<CliCommandInput, 'process' | 'cliPath' | 'cwd' | 'nodeProgram'>;
const states = new Set(['queued', 'running', 'waiting_approval', 'waiting_evidence', 'succeeded', 'failed', 'cancelled', 'expired']);
const searchStates = new Set(['complete', 'partial', 'failed']);

export function parseToolLearningStatus(stdout: string): ToolLearningLoad {
  if (stdout.length > 1_048_576) return { ok: false, reason: 'output_limit' };
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return { ok: false, reason: 'invalid_json' }; }
  if (!record(raw) || raw['ok'] !== true || raw['formatVersion'] !== 1 || !text(raw['workspaceId'], 512)
    || !Array.isArray(raw['jobs']) || raw['jobs'].length > 50 || typeof raw['totalJobs'] !== 'number' || !Number.isSafeInteger(raw['totalJobs'])
    || raw['totalJobs'] < raw['jobs'].length || typeof raw['truncated'] !== 'boolean' || raw['truncated'] !== (raw['totalJobs'] > raw['jobs'].length)) return { ok: false, reason: 'unsupported_status' };
  const jobs: ToolLearningJobView[] = [];
  for (const item of raw['jobs']) {
    if (!record(item) || !text(item['jobId'], 160) || !text(item['state'], 32) || !states.has(item['state'])
      || typeof item['attempt'] !== 'number' || !Number.isSafeInteger(item['attempt']) || item['attempt'] < 0 || item['attempt'] > 3
      || !text(item['capability'], 512) || !text(item['createdAt'], 64) || !text(item['action'], 120)
      || (item['outcomeCode'] !== undefined && !text(item['outcomeCode'], 160))
      || (item['candidateVersionId'] !== undefined && !text(item['candidateVersionId'], 160))
      || (item['searchStatus'] !== undefined && (!text(item['searchStatus'], 32) || !searchStates.has(item['searchStatus'])))
      || (item['discovered'] !== undefined && (typeof item['discovered'] !== 'number' || !Number.isSafeInteger(item['discovered']) || item['discovered'] < 0 || item['discovered'] > 20))) return { ok: false, reason: 'invalid_job' };
    jobs.push(item as ToolLearningJobView);
  }
  if (new Set(jobs.map(job => job.jobId)).size !== jobs.length) return { ok: false, reason: 'duplicate_job' };
  return { ok: true, status: { formatVersion: 1, workspaceId: raw['workspaceId'], jobs, totalJobs: raw['totalJobs'], truncated: raw['truncated'] } };
}

export async function loadToolLearningStatus(input: ToolLearningRuntime & { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<ToolLearningLoad> {
  const result = await runCliCommand({ ...input, args: ['tools', 'status', '--json'] });
  return result.ok ? parseToolLearningStatus(result.stdout) : result;
}
