import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ToolLearningRecords } from './ToolLearningRecords';
import type { ToolLearningRuntime } from '../../tool-learning/cli-status';
import type { FilePath } from '../../host-adapter/types';

afterEach(cleanup);
const status = { ok: true, formatVersion: 1, workspaceId: 'workspace:test', totalJobs: 1, truncated: false, jobs: [
  { jobId: 'job-test', state: 'waiting_approval', attempt: 1, capability: '汇总中文和 Unicode 工具调用记录', createdAt: '2026-10-30T00:00:00.000Z', action: 'replace_or_add',
    outcomeCode: 'candidate_pending_review', searchStatus: 'partial', discovered: 5, candidateVersionId: 'candidate-test' },
] };
function runtime(reply = status): ToolLearningRuntime {
  return { cliPath: 'D:/cli/main.js' as FilePath, cwd: 'D:/workspace' as FilePath, process: { spawn: async options => {
    options.onOutput(JSON.stringify(reply)); options.onExit?.({ id: 'owned', pid: 1, code: 0, signal: null });
    return { id: 'owned', pid: 1, label: options.label, command: options.command };
  }, stop: async () => {} } };
}
it('shows actual pending review and partial search without claiming activation or adding enable controls', async () => {
  render(<ToolLearningRecords runtime={runtime()} />);
  fireEvent.click(screen.getByRole('button', { name: '学习记录' }));
  expect(await screen.findByText('候选待审核')).toBeTruthy(); expect(screen.getByText(/部分来源暂不可用/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '启用' })).toBeNull();
  fireEvent.click(screen.getByText('查看依据标识')); expect(screen.getByText('candidate-test')).toBeTruthy();
});
it('distinguishes unavailable CLI from a truthful empty workspace and offers retry', async () => {
  const view = render(<ToolLearningRecords />); expect(await screen.findByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '学习记录' }));
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  view.rerender(<ToolLearningRecords runtime={runtime({ ...status, jobs: [], totalJobs: 0 })} />);
  expect(await screen.findByText(/当前工作区还没有工具学习任务/)).toBeTruthy();
});
it('unmount cancels the owned status query rather than accepting its late output', async () => {
  const stop = vi.fn(async () => {}), base = runtime();
  const view = render(<ToolLearningRecords runtime={{ ...base, process: { ...base.process,
    spawn: async () => ({ id: 'owned', pid: 1, label: 'status', command: 'node' }), stop } }} />);
  view.unmount(); await waitFor(() => expect(stop).toHaveBeenCalledWith('owned'));
});
