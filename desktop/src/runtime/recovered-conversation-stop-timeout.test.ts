import { afterEach, expect, it, vi } from 'vitest';
import type { LiveProcessInfo } from '../host-adapter/process-service';
import type { ProcessId } from '../host-adapter/types';
import { RecoveredConversationStop } from './recovered-conversation-stop';

const target: LiveProcessInfo = { id: 'old-root' as ProcessId, pid: 1, label: 'trylo-cli-v1', command: 'node',
  metadata: { projectKey: 'project', conversationId: 'conversation', runId: 'old-turn' } };
const pending = <T>(): Promise<T> => new Promise(() => {});
afterEach(() => { vi.useRealTimers(); });

it.each(['service', 'list', 'stop'] as const)('a never-returning %s fails visibly and an explicit retry can clear ownership', async boundary => {
  vi.useFakeTimers();
  let blocked = true;
  const port = { list: async () => blocked && boundary === 'list' ? pending<readonly LiveProcessInfo[]>() : blocked ? [target] : [],
    stop: async () => boundary === 'stop' ? pending<void>() : undefined };
  const owner = new RecoveredConversationStop(async () => blocked && boundary === 'service' ? pending<typeof port>() : port, () => {});
  let outcome = 'pending';
  const first = owner.stop('project', 'conversation').then(() => { outcome = 'success'; }, () => { outcome = 'failed'; });
  await vi.advanceTimersByTimeAsync(5001);
  expect(outcome).toBe('failed');
  expect(owner.view('project', 'conversation')).toMatchObject({ running: true, error: true, sendable: false });
  blocked = false;
  await owner.stop('project', 'conversation');
  expect(owner.isHeld('project', 'conversation')).toBe(false);
  await first;
});

it('a timed-out stop can still succeed from independent native absence', async () => {
  vi.useFakeTimers();
  let reads = 0;
  const owner = new RecoveredConversationStop(async () => ({ list: async () => ++reads === 1 ? [target] : [], stop: () => pending<void>() }), () => {});
  let outcome = 'pending';
  const stopped = owner.stop('project', 'conversation').then(() => { outcome = 'success'; });
  await vi.advanceTimersByTimeAsync(5001);
  expect(outcome).toBe('success');
  expect(owner.isHeld('project', 'conversation')).toBe(false);
  await stopped;
});

it('inspection timeout rejects a new send and ignores a late empty native list', async () => {
  vi.useFakeTimers();
  let answer!: (value: readonly LiveProcessInfo[]) => void;
  const held = new Promise<readonly LiveProcessInfo[]>(resolve => { answer = resolve; });
  let blocked = true;
  const owner = new RecoveredConversationStop(async () => ({ list: async () => blocked ? held : [target], stop: async () => {} }), () => {});
  let outcome = 'pending';
  const inspection = owner.assertAvailable('project', 'conversation', new Set()).then(() => { outcome = 'success'; }, () => { outcome = 'failed'; });
  await vi.advanceTimersByTimeAsync(5001);
  expect(outcome).toBe('failed');
  blocked = false;
  await expect(owner.assertAvailable('project', 'conversation', new Set())).rejects.toThrow('旧执行');
  answer([]); await vi.advanceTimersByTimeAsync(0);
  expect(owner.isHeld('project', 'conversation')).toBe(true);
  expect(outcome).toBe('failed');
  await inspection;
});

it('a timed-out child keeps only its own conversation after bulk stop', async () => {
  vi.useFakeTimers();
  const owner = new RecoveredConversationStop(async () => ({ list: async () => [target], stop: () => pending<void>() }), () => {});
  let outcome = 'pending';
  const stopped = owner.stopAll(new Set()).then(() => { outcome = 'success'; }, () => { outcome = 'failed'; });
  await vi.advanceTimersByTimeAsync(5001);
  expect(outcome).toBe('failed');
  expect(owner.isHeld('project', 'conversation')).toBe(true);
  expect(owner.isHeld('other-project', 'other')).toBe(false);
  await stopped;
});

it('late stop completion cannot clear ownership established by a subsequent retry', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const owner = new RecoveredConversationStop(async () => ({ list: async () => [target], stop: () => held }), () => {});
  let outcome = 'pending';
  const stopped = owner.stop('project', 'conversation').then(() => { outcome = 'success'; }, () => { outcome = 'failed'; });
  await vi.advanceTimersByTimeAsync(5001);
  expect(outcome).toBe('failed');
  await expect(owner.assertAvailable('project', 'conversation', new Set())).rejects.toThrow('旧执行');
  finish(); await vi.advanceTimersByTimeAsync(0);
  expect(owner.isHeld('project', 'conversation')).toBe(true);
  expect(owner.view('project', 'conversation')).toMatchObject({ running: true, sendable: false });
  await stopped;
});
