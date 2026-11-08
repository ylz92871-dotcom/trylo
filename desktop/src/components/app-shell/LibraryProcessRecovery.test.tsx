import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import type { CliCommandRecoveryPort, CliCommandRetainedStatus } from '../../host-adapter/cli-command';
import { LibraryProcessRecovery } from './LibraryProcessRecovery';

afterEach(cleanup);

function recovery(initial: readonly CliCommandRetainedStatus[]) {
  let statuses = initial, version = 0;
  const listeners = new Set<() => void>();
  const port: CliCommandRecoveryPort = {
    statuses: () => statuses,
    getVersion: () => version,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retry: vi.fn(async () => {}),
  };
  return { port, update(next: readonly CliCommandRetainedStatus[]) {
    statuses = next; version++; listeners.forEach(listener => listener());
  } };
}

it('presents concurrent library reads as one workspace notice without an unavailable retry action', () => {
  const { port } = recovery([
    { processId: 'expert-query', workspaceRoot: 'D:\\qoder worktree', state: 'stopping' },
    { processId: 'expert-requests', workspaceRoot: 'D:\\qoder worktree', state: 'stopping' },
  ]);
  render(<LibraryProcessRecovery port={port} floating />);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status')).toHaveTextContent('正在停止库操作…（2 项）');
  expect(screen.getAllByText('工作区：D:\\qoder worktree')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: '重试停止' })).not.toBeInTheDocument();
});

it('retries every failed handle in the chosen workspace and leaves ongoing stops and other workspaces alone', () => {
  const { port } = recovery([
    { processId: 'still-stopping', workspaceRoot: 'D:/a', state: 'stopping' },
    { processId: 'failed-query', workspaceRoot: 'D:/a', state: 'stop_unconfirmed', error: 'query-stop-error' },
    { processId: 'failed-requests', workspaceRoot: 'D:/a', state: 'stop_unconfirmed', error: 'requests-stop-error' },
    { processId: 'other-workspace', workspaceRoot: 'D:/b', state: 'stopping' },
  ]);
  render(<LibraryProcessRecovery port={port} />);
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '重试停止' }));
  expect(port.retry).toHaveBeenCalledTimes(2);
  expect(port.retry).toHaveBeenNthCalledWith(1, 'failed-query');
  expect(port.retry).toHaveBeenNthCalledWith(2, 'failed-requests');
  expect(screen.getByText('failed-query: query-stop-error')).toBeInTheDocument();
  expect(screen.getByText('failed-requests: requests-stop-error')).toBeInTheDocument();
});

it('reflects the owner stop result and disappears only when the owner releases the handles', () => {
  const entry = { processId: 'query', workspaceRoot: 'D:/a' };
  const owner = recovery([{ ...entry, state: 'stopping' }]);
  render(<LibraryProcessRecovery port={owner.port} />);
  act(() => owner.update([{ ...entry, state: 'stop_unconfirmed', error: 'process_stop_deadline' }]));
  expect(screen.getByRole('alert')).toHaveTextContent('库操作尚未确认停止');
  expect(screen.getByRole('button', { name: '重试停止' })).toBeEnabled();
  act(() => owner.update([]));
  expect(screen.queryByLabelText('库进程停止状态')).not.toBeInTheDocument();
});
