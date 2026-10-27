import { afterEach, expect, it, vi } from 'vitest';
import type { ProcessService, RecoverableProcess, RetainedProcessOutput } from '../host-adapter/process-service';
import { RecoveredTeamOutput } from './recovered-team-output';
import { canSendSubagentInput, closeSubagentInputProcess } from '../host-adapter/trylo-v1-subagent-control';

vi.mock('../host-adapter/index', () => ({ hostAdapter: { process: { send: vi.fn() } } }));
const process: RecoverableProcess = { id: 'root', pid: 123, projectKey: 'workspace', conversationId: 'chat',
  identity: { teamRunId: 'team', turnId: 'turn' } };
const line = (sequence: number, value: unknown) => ({ sequence, stream: 'stdout' as const, line: JSON.stringify(value) });
function page(patch: Partial<RetainedProcessOutput> = {}): RetainedProcessOutput {
  return { version: 1, process, records: [], nextSequence: 0, hasMore: false, gap: false,
    finished: false, captureComplete: true, exit: null, answeredRequests: [], ...patch };
}
function fixture(pages: RetainedProcessOutput[], processes: readonly RecoverableProcess[] = [process]) {
  const readOutput = vi.fn(async () => pages.shift()!);
  const spawn = vi.fn(); const send = vi.fn(); const control = vi.fn(); const exited = vi.fn();
  const list = vi.fn<[], ReturnType<ProcessService['list']>>(async () => []);
  const recoveryList = vi.fn(async () => processes);
  const port: ProcessService = { spawn, send, stop: vi.fn(), closeInput: vi.fn(), list, recoveryList, readOutput };
  return { readOutput, recoveryList, list, spawn, send, control, exited,
    recovery: new RecoveredTeamOutput(() => port, control, exited, vi.fn()) };
}
afterEach(() => closeSubagentInputProcess(process.id));

it('matches the full owner identity and never chooses another conversation or workspace', async () => {
  const fixture1 = fixture([], [{ ...process, id: 'other-chat', conversationId: 'other' }, { ...process, id: 'other-project', projectKey: 'other' },
    { ...process, id: 'other-team', identity: { ...process.identity, teamRunId: 'other' } }]);
  expect(await fixture1.recovery.read('workspace', 'chat', 'team')).toBeNull();
  expect(fixture1.readOutput).not.toHaveBeenCalled();
});

it('keeps ownership and disables member input after a mismatched exit receipt', async () => {
  const target = fixture([page(), page({ finished: true, exit: { id: 'different-root', pid: 999, code: 0, signal: null } })]);
  (await target.recovery.read('workspace', 'chat', 'team'))?.acknowledge();
  await expect(target.recovery.read('workspace', 'chat', 'team')).rejects.toThrow();
  expect(target.recovery.view('workspace', 'chat')).toMatchObject({ sendable: false, activeProcessId: null });
  expect(canSendSubagentInput(process.id)).toBe(false);
});

it('releases an expired output owner only after the live registry independently confirms absence', async () => {
  const target = fixture([page()]);
  (await target.recovery.read('workspace', 'chat', 'team'))?.acknowledge();
  target.recoveryList.mockResolvedValue([]);
  const ended = await target.recovery.read('workspace', 'chat', 'team');
  expect(target.list).toHaveBeenCalledOnce();
  expect(ended?.events).toContainEqual(expect.objectContaining({ type: 'loop_end', isError: true }));
  expect(target.recovery.view('workspace', 'chat')).toBeNull();
  expect(canSendSubagentInput(process.id)).toBe(false);
});

it('does not treat output eviction as exit while the original registry id is still live', async () => {
  const target = fixture([page()]);
  (await target.recovery.read('workspace', 'chat', 'team'))?.acknowledge();
  target.recoveryList.mockResolvedValue([]);
  target.list.mockResolvedValue([{ id: process.id, pid: process.pid, label: 'trylo-cli-v1', command: '',
    metadata: { projectKey: process.projectKey, conversationId: process.conversationId } }]);
  await expect(target.recovery.read('workspace', 'chat', 'team')).rejects.toThrow();
  expect(target.recovery.view('workspace', 'chat')).toMatchObject({ running: true, sendable: false, activeProcessId: null });
  expect(canSendSubagentInput(process.id)).toBe(false);
});

it('revokes restored controls when subsequent recovery-list IO fails without releasing ownership', async () => {
  const target = fixture([page()]);
  (await target.recovery.read('workspace', 'chat', 'team'))?.acknowledge();
  target.recoveryList.mockRejectedValueOnce(new Error('isolated recovery lookup failure'));
  await expect(target.recovery.read('workspace', 'chat', 'team')).rejects.toThrow('lookup failure');
  expect(target.recovery.view('workspace', 'chat')).toMatchObject({ sendable: false, activeProcessId: null });
  expect(canSendSubagentInput(process.id)).toBe(false);
});

it('rejects non-boolean completeness instead of restoring input from a malformed snapshot', async () => {
  const target = fixture([JSON.parse(JSON.stringify({ ...page(), captureComplete: 'yes' }))]);
  await expect(target.recovery.read('workspace', 'chat', 'team')).rejects.toThrow();
  expect(canSendSubagentInput(process.id)).toBe(false);
  expect(target.recovery.view('workspace', 'chat')).toMatchObject({ sendable: false, activeProcessId: null });
});

it('does not release expired ownership when the independent process registry is malformed', async () => {
  const target = fixture([page()]);
  (await target.recovery.read('workspace', 'chat', 'team'))?.acknowledge();
  target.recoveryList.mockResolvedValue([]);
  target.list.mockResolvedValue(JSON.parse('[{"pid":999}]'));
  await expect(target.recovery.read('workspace', 'chat', 'team')).rejects.toThrow('invalid id');
  expect(target.recovery.view('workspace', 'chat')).toMatchObject({ sendable: false, activeProcessId: null });
});

it('confirmed Stop releases a malformed replay hold and still exposes its original cancelled terminal', async () => {
  const target = fixture([page(), page({ finished: true, exit: { id: 'wrong-root', pid: 999, code: 0, signal: null } })]);
  (await target.recovery.read('workspace', 'chat', 'team'))?.acknowledge();
  await expect(target.recovery.read('workspace', 'chat', 'team')).rejects.toThrow();
  target.recovery.requestStop('workspace', 'chat');
  target.list.mockResolvedValue([]);
  target.recoveryList.mockResolvedValue([]);
  await target.recovery.confirmStopped('workspace', 'chat');
  expect(target.recovery.view('workspace', 'chat')).toBeNull();
  const replay = await target.recovery.read('workspace', 'chat', 'team');
  expect(replay?.events).toContainEqual(expect.objectContaining({ type: 'loop_end', reason: 'cancelled' }));
  expect(target.readOutput).toHaveBeenCalledTimes(2);
});

it('Stop consumes a retained natural completion before deciding the fallback cancellation outcome', async () => {
  const terminal = { type: 'run_result', status: 'completed', finishReason: 'stop', sessionId: 's', turnId: 't',
    iterations: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: 1, lastMessage: 'finished naturally' };
  const target = fixture([page(), page({ records: [line(1, terminal)], nextSequence: 1, finished: true,
    exit: { id: process.id, pid: process.pid, code: 0, signal: null } })]);
  (await target.recovery.read('workspace', 'chat', 'team'))?.acknowledge();
  target.recovery.requestStop('workspace', 'chat'); target.list.mockResolvedValue([]);
  await target.recovery.confirmStopped('workspace', 'chat');
  const replay = await target.recovery.read('workspace', 'chat', 'team');
  expect(replay?.events).toContainEqual(expect.objectContaining({ type: 'loop_end', isError: false }));
  expect(replay?.events.some(event => event.type === 'loop_end' && event.reason === 'cancelled')).toBe(false);
});

it('catches up output without spawning or resending, and suppresses approvals answered after an earlier page', async () => {
  const request = { type: 'control_request', request_id: 'approval-1', request: { subtype: 'can_use_tool', tool_name: 'write_file', input: {} } };
  const target = fixture([
    page({ records: [line(1, request), line(2, { type: 'message_start' })], nextSequence: 2, hasMore: true }),
    page({ records: [line(3, { type: 'message_delta', text: 'retained answer' }), line(4, { type: 'message_end' })],
      nextSequence: 4, answeredRequests: ['approval-1'] }),
  ]);
  const replay = await target.recovery.read('workspace', 'chat', 'team');
  expect(replay?.events).toContainEqual(expect.objectContaining({ type: 'text', fullText: 'retained answer' }));
  expect(target.control).not.toHaveBeenCalled(); expect(target.spawn).not.toHaveBeenCalled(); expect(target.send).not.toHaveBeenCalled();
  expect(canSendSubagentInput(process.id)).toBe(true);
  expect(target.recovery.view('workspace', 'chat')).toMatchObject({ activeProcessId: 'root', sendable: false });
});

it('keeps uncommitted catch-up after navigation and advances acknowledged output only once', async () => {
  const target = fixture([
    page({ records: [line(1, { type: 'message_start' }), line(2, { type: 'message_delta', text: 'first' })], nextSequence: 2 }),
    page({ records: [line(3, { type: 'message_end' })], nextSequence: 3 }),
    page({ nextSequence: 3 }),
  ]);
  const cancelledRead = await target.recovery.read('workspace', 'chat', 'team');
  expect(cancelledRead?.events.length).toBeGreaterThan(0);
  const retried = await target.recovery.read('workspace', 'chat', 'team');
  expect(retried?.events).toContainEqual(expect.objectContaining({ type: 'text', fullText: 'first' }));
  retried?.acknowledge();
  expect((await target.recovery.read('workspace', 'chat', 'team'))?.events).toEqual([]);
  expect(target.readOutput.mock.calls).toHaveLength(3);
});

it('rehydrates a pending request once and releases its member controls on observed exit', async () => {
  const request = { type: 'control_request', request_id: 'pending', request: { subtype: 'can_use_tool', tool_name: 'read_file', input: {} } };
  const target = fixture([
    page({ records: [line(1, request)], nextSequence: 1 }), page({ nextSequence: 1 }),
    page({ nextSequence: 1, finished: true, exit: { id: process.id, pid: process.pid, code: 1, signal: null } }),
  ]);
  (await target.recovery.read('workspace', 'chat', 'team'))?.acknowledge();
  (await target.recovery.read('workspace', 'chat', 'team'))?.acknowledge();
  expect(target.control).toHaveBeenCalledTimes(1);
  const exited = await target.recovery.read('workspace', 'chat', 'team');
  expect(exited?.events).toContainEqual(expect.objectContaining({ type: 'loop_end', isError: true }));
  expect(target.recovery.view('workspace', 'chat')).toBeNull(); expect(canSendSubagentInput(process.id)).toBe(false);
  expect(target.exited).toHaveBeenCalledWith(process.id);
});

it('does not expose actions or interpret a terminal result after retention loses a prefix', async () => {
  const target = fixture([page({ gap: true, records: [line(5, { type: 'message_end' })], nextSequence: 5 })]);
  await expect(target.recovery.read('workspace', 'chat', 'team')).rejects.toThrow('缺口');
  expect(target.recovery.view('workspace', 'chat')).toMatchObject({ activeProcessId: null, sendable: false, error: true });
  expect(target.control).not.toHaveBeenCalled(); expect(canSendSubagentInput(process.id)).toBe(false);
});

it('attributes a recovered Stop only after actual exit and keeps a failed stop retryable while live', async () => {
  const target = fixture([page(), page(), page({ finished: true, exit: { id: process.id, pid: process.pid, code: 1, signal: null } })]);
  (await target.recovery.read('workspace', 'chat', 'team'))?.acknowledge();
  target.recovery.requestStop('workspace', 'chat');
  const stillLive = await target.recovery.read('workspace', 'chat', 'team');
  expect(stillLive?.events.some(event => event.type === 'loop_end')).toBe(false);
  expect(target.recovery.view('workspace', 'chat')?.sendable).toBe(false);
  stillLive?.acknowledge();
  const exited = await target.recovery.read('workspace', 'chat', 'team');
  expect(exited?.events).toContainEqual(expect.objectContaining({ type: 'loop_end', reason: 'cancelled' }));
  expect(target.recovery.view('workspace', 'chat')).toBeNull();
});

it('bounds growing text snapshots and does not let a slow old acknowledgement discard newer output', async () => {
  const deltas = Array.from({ length: 500 }, (_, index) => line(index + 2, { type: 'message_delta', text: 'x' }));
  const target = fixture([
    page({ records: [line(1, { type: 'message_start' }), ...deltas], nextSequence: 501 }),
    page({ records: [line(502, { type: 'message_delta', text: 'tail' })], nextSequence: 502 }),
    page({ nextSequence: 502 }),
  ]);
  const old = await target.recovery.read('workspace', 'chat', 'team');
  expect(old?.events.filter(event => event.type === 'text')).toHaveLength(1);
  const newer = await target.recovery.read('workspace', 'chat', 'team');
  old?.acknowledge(); old?.acknowledge();
  const pending = await target.recovery.read('workspace', 'chat', 'team');
  expect(pending?.events).toContainEqual(expect.objectContaining({ type: 'text', fullText: 'x'.repeat(500) + 'tail' }));
  newer?.acknowledge();
});

it('retains protocol diagnostics on recovered exit instead of hiding the reason behind an unknown terminal', async () => {
  const target = fixture([page({ records: [{ sequence: 1, stream: 'stdout', line: 'invalid-json-wire' }],
    nextSequence: 1, finished: true, exit: { id: process.id, pid: process.pid, code: 1, signal: null } })]);
  const replay = await target.recovery.read('workspace', 'chat', 'team');
  expect(replay?.events).toContainEqual(expect.objectContaining({ type: 'runtime_warning', code: 'protocol_rejected' }));
});
