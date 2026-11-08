import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkReviewPanel } from './WorkReviewPanel';
import type { StoredWorkResult } from '../../results/conversation-result-types';

afterEach(cleanup);

const host = { openFile: vi.fn(), openFileWithApp: vi.fn(), showInFolder: vi.fn(), copyToClipboard: vi.fn() };
const empty: StoredWorkResult = { artifacts: [], artifactCountTotal: 0, truncated: false };

describe('Work review panel', () => {
  it('keeps partial warning and truncation visible outside the compact entry', () => {
    render(<WorkReviewPanel result={{ ...empty, truncated: true, latestRun: {
      runId: 'r1', turnId: 't1', startedAt: 1, status: 'degraded',
      warning: '部分文件未完成检查', createdIds: [], updatedIds: [], discoveredIds: [],
    } }} workspaceRoot="D:/repo" host={host} />);
    expect(screen.getByText('交付记录')).toBeTruthy();
    expect(screen.getByText('0 个本轮交付物')).toBeTruthy();
    expect(screen.getByText('部分文件未完成检查').getAttribute('role')).toBe('status');
    expect(screen.getByText('交付记录较多，当前仅显示已保留的文件。')).toBeTruthy();
    expect(screen.getByText('本轮还没有可交付的产物。')).toBeTruthy();
  });

  it('opens a retained delivery through the existing preview callback', () => {
    const path = '.trylo/out/report.pdf';
    const onPreviewArtifact = vi.fn();
    render(<WorkReviewPanel result={{ artifacts: [{
      id: path, target: { kind: 'file', relativePath: path }, displayName: 'report.pdf',
      artifactKind: 'file', version: 1, firstSeenAt: 1, updatedAt: 2, firstRunId: 'r1',
      lastRunId: 'r1', lastTurnId: 't1', lastChange: 'discovered', sources: ['recovery'],
    }], artifactCountTotal: 1, truncated: false, latestRun: {
      runId: 'r1', turnId: 't1', startedAt: 1, status: 'completed',
      createdIds: [], updatedIds: [], discoveredIds: [path],
    } }} workspaceRoot="D:/repo" host={host} onPreviewArtifact={onPreviewArtifact} />);
    expect(screen.getByText('1 个本轮交付物')).toBeTruthy();
    expect(screen.getByText('已发现')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `打开文件 ${path}` }));
    expect(onPreviewArtifact).toHaveBeenCalledWith('D:/repo/.trylo/out/report.pdf');
  });
});
