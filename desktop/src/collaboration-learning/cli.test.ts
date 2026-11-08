import { expect, it, vi } from 'vitest';
import type { CliCommandInput } from '../host-adapter/cli-command';
import type { FilePath } from '../host-adapter/types';
import { activeWorkspaceSuspension, createCollaborationLearningPort, parseCollaborationStatus } from './cli';

const runtime = { cliPath: 'D:/candidate/cli/dist/cmd/trylo/main.js' as FilePath, cwd: 'D:/acceptance/workspace' as FilePath,
  nodeProgram: 'D:/candidate/node.exe', process: { spawn: vi.fn(), stop: vi.fn() } };
const practice = { familyId: 'family-a', versionId: 'version-a', title: 'Supply producer references', hypothesis: 'Missing references caused observed rework',
  status: 'trial', conditions: { dependency: 'artifact', roles: ['worker'] }, evidenceRefs: ['fact:independent-check'],
  actions: [{ actionId: 'action-a', instruction: 'Share the producer brief before dependent implementation', audience: 'parent', operation: 'share_reference' }], corrections: [] };
const reply = () => ({ schemaVersion: 2, ok: true, scope: runtime.cwd, boardSequence: 9, practices: [practice],
  cycles: [{ cycleId: 'cycle-a', requestId: 'grant-a', phase: 'waiting_evidence', grant: { maxModelTokens: 16000 }, spent: { modelTokens: 400, modelCalls: 1 } }] });

it('queries the current workspace through the existing CLI transport without a learning invocation', async () => {
  let captured: CliCommandInput | undefined;
  const signal = new AbortController().signal;
  const port = createCollaborationLearningPort(runtime, async input => { captured = input; return { ok: true, stdout: JSON.stringify(reply()) }; });
  const result = await port.status(signal);
  expect(result.ok).toBe(true);
  expect(captured).toEqual({ ...runtime, signal, timeoutMs: 30000,
    args: ['learn', 'collaboration', 'status', '--workspace', runtime.cwd, '--json'] });
  expect(runtime.process.spawn).not.toHaveBeenCalled();
});

it('rejects malformed or other-workspace replies instead of showing unrelated practices', () => {
  expect(parseCollaborationStatus('{', runtime.cwd)).toEqual({ ok: false, reason: 'invalid_collaboration_reply' });
  for (const invalid of [{ ...reply(), scope: 'D:/other' }, { ...reply(), boardSequence: -1 },
    { ...reply(), practices: [{ ...practice, actions: [{ ...practice.actions[0], instruction: 42 }] }] }]) {
    expect(parseCollaborationStatus(JSON.stringify(invalid), runtime.cwd).ok).toBe(false);
  }
  expect(parseCollaborationStatus(JSON.stringify({ ...reply(), scope: 'd:\\acceptance\\workspace\\' }), runtime.cwd).ok).toBe(true);
});

it('requires explicit user correction and restoration predecessor and waits for a committed receipt', async () => {
  const run = vi.fn(async (_input: CliCommandInput) => ({ ok: true as const, stdout: JSON.stringify({ schemaVersion: 2, ok: true, correctionId: 'correction-a' }) }));
  const port = createCollaborationLearningPort(runtime, run), signal = new AbortController().signal;
  expect(await port.correct({ familyId: 'family-a', action: 'suspend', evidenceRef: 'model:claim' }, signal)).toEqual({ ok: false, reason: 'explicit_user_correction_required' });
  expect(await port.correct({ familyId: 'family-a', action: 'restore', evidenceRef: 'user:actual' }, signal)).toEqual({ ok: false, reason: 'explicit_user_correction_required' });
  expect(run).not.toHaveBeenCalled();
  expect(await port.correct({ familyId: 'family-a', action: 'suspend', evidenceRef: 'user:actual' }, signal)).toEqual({ ok: true, correctionId: 'correction-a' });
  expect(run.mock.calls[0]?.[0].args).toEqual(['learn', 'collaboration', 'correct', '--workspace', runtime.cwd,
    '--family', 'family-a', '--action', 'suspend', '--scope', 'workspace', '--evidence-ref', 'user:actual', '--json']);
  expect(run.mock.calls[0]?.[0].timeoutMs).toBe(30000);
  await port.correct({ familyId: 'family-a', action: 'restore', evidenceRef: 'user:restore', replacesCorrectionId: 'correction-a' }, signal);
  expect(run.mock.calls[1]?.[0].args).toContain('--replaces');
  expect(run.mock.calls[1]?.[0].args).toContain('correction-a');
  run.mockResolvedValueOnce({ ok: true, stdout: '{"schemaVersion":2,"ok":true}' });
  expect(await port.correct({ familyId: 'family-a', action: 'suspend', evidenceRef: 'user:actual' }, signal)).toEqual({ ok: false, reason: 'collaboration_correction_not_committed' });
});

it('pre-cancelled status/correction never starts a child and a restored suspension stops being active', async () => {
  const process = { spawn: vi.fn(), stop: vi.fn() }, controller = new AbortController(); controller.abort();
  const port = createCollaborationLearningPort({ ...runtime, process });
  expect(await port.status(controller.signal)).toEqual({ ok: false, reason: 'cancelled' });
  expect(await port.correct({ familyId: 'family-a', action: 'suspend', evidenceRef: 'user:actual' }, controller.signal)).toEqual({ ok: false, reason: 'cancelled' });
  expect(process.spawn).not.toHaveBeenCalled();
  const parsed = parseCollaborationStatus(JSON.stringify({ ...reply(), practices: [{ ...practice, corrections: [
    { factId: 'suspend-a', action: 'suspend', appliesTo: { kind: 'workspace' }, evidenceRef: 'user:suspend' },
    { factId: 'restore-a', action: 'restore', appliesTo: { kind: 'workspace' }, evidenceRef: 'user:restore', replacesCorrectionId: 'suspend-a' },
  ] }] }), runtime.cwd);
  expect(parsed.ok && activeWorkspaceSuspension(parsed.practices[0]!)).toBeUndefined();
});

it('retains exact class and single-task correction selectors and rejects missing selectors', () => {
  const corrections = [
    { factId: 'class-a', action: 'suspend', appliesTo: { kind: 'class', taskFamily: 'unit-conversion', role: 'worker' }, evidenceRef: 'user:class' },
    { factId: 'once-a', action: 'suspend', appliesTo: { kind: 'once', taskId: 'actual-task-a' }, evidenceRef: 'user:once' },
  ];
  const parsed = parseCollaborationStatus(JSON.stringify({ ...reply(), practices: [{ ...practice, corrections }] }), runtime.cwd);
  expect(parsed.ok && parsed.practices[0]?.corrections).toEqual([
    { factId: 'class-a', action: 'suspend', scopeKind: 'class', taskFamily: 'unit-conversion', role: 'worker', evidenceRef: 'user:class' },
    { factId: 'once-a', action: 'suspend', scopeKind: 'once', taskId: 'actual-task-a', evidenceRef: 'user:once' },
  ]);
  expect(parseCollaborationStatus(JSON.stringify({ ...reply(), practices: [{ ...practice,
    corrections: [{ ...corrections[1], appliesTo: { kind: 'once' } }] }] }), runtime.cwd).ok).toBe(false);
});
