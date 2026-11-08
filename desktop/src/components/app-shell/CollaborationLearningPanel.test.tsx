import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import type { FilePath } from '../../host-adapter/types';
import type { CollaborationLearningRuntime, CollaborationStatus, createCollaborationLearningPort } from '../../collaboration-learning/cli';
import { CollaborationLearningPanel } from './CollaborationLearningPanel';

const mocks = vi.hoisted(() => ({ ports: new Map<string, ReturnType<typeof createCollaborationLearningPort>>() }));
vi.mock('../../collaboration-learning/cli', async () => ({ ...await vi.importActual('../../collaboration-learning/cli'),
  createCollaborationLearningPort: (runtime: CollaborationLearningRuntime) => mocks.ports.get(runtime.cwd),
}));
afterEach(() => { cleanup(); mocks.ports.clear(); });
const runtime = (cwd = 'D:/workspace-a'): CollaborationLearningRuntime => ({ cwd: cwd as FilePath,
  cliPath: 'D:/candidate/main.js' as FilePath, process: { spawn: vi.fn(), stop: vi.fn() } });
const status = (scope = 'D:/workspace-a', title = 'Share actual producer context'): { ok: true } & CollaborationStatus => ({ ok: true, scope, boardSequence: 3,
  cycles: [{ cycleId: 'cycle-a', requestId: 'daily-a', phase: 'waiting_evidence', maxTokens: 16000, spentTokens: 640, spentCalls: 1 }],
  practices: [{ familyId: 'family-a', versionId: 'version-a', title, hypothesis: 'Observed context loss caused numeric rework', status: 'trial', dependency: 'artifact',
    roles: ['worker'], actions: [{ actionId: 'action-a', instruction: 'Send actual producer references before implementation', audience: 'parent', operation: 'share_reference' }],
    evidenceRefs: ['actual-check:a'], corrections: [] }] });

it('renders quota accounting and only reports a correction after the CLI receipt and refreshed state', async () => {
  const initial = status(), suspended = { ...initial, practices: [{ ...initial.practices[0]!, status: 'suspended' as const,
    corrections: [{ factId: 'suspension-a', action: 'suspend' as const, scopeKind: 'workspace' as const, evidenceRef: 'user:actual-suspension' }] }] };
  const port = { status: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(suspended).mockResolvedValue(initial),
    correct: vi.fn().mockResolvedValue({ ok: true, correctionId: 'suspension-a' }) };
  mocks.ports.set('D:/workspace-a', port);
  render(<CollaborationLearningPanel runtime={runtime()} />);
  expect(await screen.findByText(/等待协作证据/)).toHaveTextContent('640 / 16,000 tokens');
  fireEvent.click(await screen.findByRole('button', { name: '在此工作区停用' }));
  const restore = await screen.findByRole('button', { name: '恢复此工作区试用' });
  expect(port.correct.mock.calls[0]?.[0]).toEqual({ familyId: 'family-a', action: 'suspend', evidenceRef: expect.stringMatching(/^user:desktop-collaboration:/) });
  fireEvent.click(restore);
  await waitFor(() => expect(port.correct).toHaveBeenCalledTimes(2));
  expect(port.correct.mock.calls[1]?.[0]).toEqual({ familyId: 'family-a', action: 'restore', replacesCorrectionId: 'suspension-a',
    evidenceRef: expect.stringMatching(/^user:desktop-collaboration:/) });
  expect(await screen.findByRole('button', { name: '在此工作区停用' })).toBeEnabled();
});

it('shows invalid or unconfirmed replies and never pretends the correction took effect', async () => {
  const port = { status: vi.fn().mockResolvedValue(status()), correct: vi.fn().mockResolvedValue({ ok: false, reason: 'collaboration_correction_not_committed' }) };
  mocks.ports.set('D:/workspace-a', port);
  render(<CollaborationLearningPanel runtime={runtime()} />);
  fireEvent.click(await screen.findByRole('button', { name: '在此工作区停用' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('纠正未能确认');
  expect(screen.queryByRole('button', { name: '恢复此工作区试用' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '在此工作区停用' })).toBeDisabled();
});

it('aborts a pending old-workspace correction and permits the new workspace after navigation', async () => {
  let finish!: (value: { ok: true; correctionId: string }) => void;
  const old = { status: vi.fn().mockResolvedValue(status()), correct: vi.fn((_input: unknown, _signal: AbortSignal) => new Promise<{ ok: true; correctionId: string }>(resolve => { finish = resolve; })) };
  const current = { status: vi.fn().mockResolvedValue(status('D:/workspace-b', 'New workspace practice')), correct: vi.fn() };
  mocks.ports.set('D:/workspace-a', old); mocks.ports.set('D:/workspace-b', current);
  const rendered = render(<CollaborationLearningPanel runtime={runtime()} />);
  fireEvent.click(await screen.findByRole('button', { name: '在此工作区停用' }));
  await waitFor(() => expect(old.correct).toHaveBeenCalledOnce());
  const oldSignal = old.correct.mock.calls[0]?.[1] as AbortSignal;
  rendered.rerender(<CollaborationLearningPanel runtime={runtime('D:/workspace-b')} />);
  expect(await screen.findByText(/New workspace practice/)).toBeInTheDocument();
  expect(oldSignal.aborted).toBe(true);
  expect(screen.getByRole('button', { name: '在此工作区停用' })).toBeEnabled();
  expect(screen.queryByText(/Share actual producer context/)).not.toBeInTheDocument();
  await act(async () => finish({ ok: true, correctionId: 'late-old' }));
  expect(screen.getByText(/New workspace practice/)).toBeInTheDocument();
  expect(old.status).toHaveBeenCalledOnce();
});
