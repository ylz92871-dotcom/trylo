import { describe, expect, it } from 'vitest';
import { parseToolLearningStatus, loadToolLearningStatus } from './cli-status';
import type { FilePath } from '../host-adapter/types';
import type { ProcessService } from '../host-adapter/process-service';

const job = { jobId: 'tool-learning_v1_example', state: 'waiting_evidence', attempt: 1, capability: '表格中的金额汇总', createdAt: '2026-10-30T00:00:00.000Z', action: 'replace_or_add',
  outcomeCode: 'verification_recipe_required', searchStatus: 'partial', discovered: 5 };
const payload = (jobs: readonly unknown[] = [job]) => JSON.stringify({ ok: true, formatVersion: 1, workspaceId: 'workspace:test', jobs, totalJobs: jobs.length, truncated: false });
const runtime = { cliPath: 'D:/cli/main.js' as FilePath, cwd: 'D:/workspace' as FilePath };

describe('tool learning status protocol', () => {
  it('decodes the bounded versioned projection and rejects future or partially corrupt replies', () => {
    const loaded = parseToolLearningStatus(payload()); expect(loaded.ok).toBe(true);
    expect(parseToolLearningStatus(payload([])).ok).toBe(true);
    for (const raw of ['not-json', payload().replace('"formatVersion":1', '"formatVersion":2'), payload([{ ...job, attempt: -1 }]),
      payload([{ ...job, discovered: 21 }]), payload([{ ...job, state: 'active' }]), payload([job, job]), payload([{ ...job, capability: '' }])]) expect(parseToolLearningStatus(raw).ok).toBe(false);
  });

  it('uses the selected CLI and cwd, and never opens a provider or raw Board file', async () => {
    const calls: Parameters<ProcessService['spawn']>[0][] = [];
    const process: Pick<ProcessService, 'spawn' | 'stop'> = { async spawn(options) {
      calls.push(options); options.onOutput(payload()); options.onExit?.({ id: 'status', pid: 1, code: 0, signal: null });
      return { id: 'status', pid: 1, label: options.label, command: options.command };
    }, stop: async () => {} };
    expect((await loadToolLearningStatus({ ...runtime, process })).ok).toBe(true);
    expect(calls[0]?.args.slice(-3)).toEqual(['tools', 'status', '--json']); expect(calls[0]?.cwd).toEqual(runtime.cwd);
  });

  it('rejects an old CLI exit or incomplete native pipe capture instead of showing an empty list', async () => {
    for (const info of [{ code: 2 }, { code: 0, outputComplete: false }]) {
      const process: Pick<ProcessService, 'spawn' | 'stop'> = { async spawn(options) {
        options.onOutput(payload([])); options.onExit?.({ id: 'status', pid: 1, signal: null, ...info });
        return { id: 'status', pid: 1, label: options.label, command: options.command };
      }, stop: async () => {} };
      expect((await loadToolLearningStatus({ ...runtime, process })).ok).toBe(false);
    }
  });
});
