import { afterEach, expect, it, vi } from 'vitest';
import type { LiveProcessInfo } from '../host-adapter/process-service';
import type { ProcessId } from '../host-adapter/types';
import { RecoveredConversationStop } from './recovered-conversation-stop';

const target: LiveProcessInfo = { id: 'old-root' as ProcessId, pid: 1, label: 'trylo-cli-v1', command: 'node',
  metadata: { projectKey: 'project', conversationId: 'conversation', runId: 'old-turn' } };
const pending = <T>(): Promise<T> => new Promise(() => {});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it.each(['confirmation', 'pause', 'slow-list'] as const)('exit %s cannot extend confirmation beyond its wall-clock deadline', async boundary => {
  vi.useFakeTimers();
  let reads = 0;
  const list = async (): Promise<readonly LiveProcessInfo[]> => {
    if (++reads === 1) return [target];
    if (boundary === 'confirmation') return pending();
    if (boundary === 'slow-list') await new Promise(resolve => setTimeout(resolve, 4_000));
    return [target];
  };
  const pause = boundary === 'pause' ? () => pending<void>() : () => new Promise<void>(resolve => setTimeout(resolve, 50));
  const owner = new RecoveredConversationStop(async () => ({ list, stop: async () => {} }), () => {}, pause, () => Date.now());
  let outcome = 'pending';
  const stopped = owner.stop('project', 'conversation').then(() => { outcome = 'success'; }, () => { outcome = 'failed'; });
  await vi.advanceTimersByTimeAsync(5_001);
  expect(outcome).toBe('failed');
  expect(owner.view('project', 'conversation')).toMatchObject({ running: true, error: true, sendable: false });
  await stopped;
});

it('bulk discovery timeout keeps its discovery hold until an explicit successful bulk retry', async () => {
  vi.useFakeTimers();
  let blocked = true;
  const owner = new RecoveredConversationStop(async () => ({ list: () => blocked ? pending<readonly LiveProcessInfo[]>() : Promise.resolve([]),
    stop: async () => {} }), () => {});
  let outcome = 'pending';
  const stopped = owner.stopAll(new Set()).then(() => { outcome = 'success'; }, () => { outcome = 'failed'; });
  await vi.advanceTimersByTimeAsync(5_001);
  expect(outcome).toBe('failed');
  expect(owner.isHeld('project', 'conversation')).toBe(true);
  blocked = false; await owner.stopAll(new Set());
  expect(owner.isHeld('project', 'conversation')).toBe(false);
  await stopped;
});

it('Stop queued behind a hung inspection performs cleanup once the inspection times out', async () => {
  vi.useFakeTimers();
  let reads = 0; let live = true;
  const stop = vi.fn(async () => { live = false; });
  const owner = new RecoveredConversationStop(async () => ({ list: () => ++reads === 1 ? pending<readonly LiveProcessInfo[]>() : Promise.resolve(live ? [target] : []), stop }), () => {});
  const inspected = owner.assertAvailable('project', 'conversation', new Set()).catch(() => {});
  let outcome = 'pending';
  const stopped = owner.stop('project', 'conversation').then(() => { outcome = 'success'; });
  await vi.advanceTimersByTimeAsync(5_001);
  expect(outcome).toBe('success'); expect(stop).toHaveBeenCalledTimes(1);
  expect(owner.isHeld('project', 'conversation')).toBe(false);
  await Promise.all([inspected, stopped]);
});
