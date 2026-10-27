import { expect, it, vi } from 'vitest';
import type { LiveProcessInfo } from '../host-adapter/process-service';
import type { ProcessId } from '../host-adapter/types';
import { RecoveredConversationStop } from './recovered-conversation-stop';

const target: LiveProcessInfo = { id: 'old-root' as ProcessId, pid: 1, label: 'trylo-cli-v1', command: 'node',
  metadata: { projectKey: 'project', conversationId: 'conversation', runId: 'old-turn' } };

it('refuses a peer team lease even when this shell lists no roots, and never pretends to stop that peer', async () => {
  const stop = vi.fn(async () => {}); let owned = true;
  const owner = new RecoveredConversationStop(async () => ({ list: async () => [], stop, hasTeamOwner: async () => owned }), () => {});
  await expect(owner.assertAvailable('project', 'conversation', new Set())).rejects.toThrow('另一个 Trylo 窗口');
  await expect(owner.stop('project', 'conversation')).rejects.toThrow('原窗口停止');
  expect(stop).not.toHaveBeenCalled(); expect(owner.isHeld('project', 'conversation')).toBe(true);
  owned = false; await owner.stop('project', 'conversation');
  expect(owner.isHeld('project', 'conversation')).toBe(false);
});

it('does not confuse an excluded locally supervised root with an external lease', async () => {
  const hasTeamOwner = vi.fn(async () => true);
  const owner = new RecoveredConversationStop(async () => ({ list: async () => [target], stop: async () => {}, hasTeamOwner }), () => {});
  await owner.assertAvailable('project', 'conversation', new Set([target.id]));
  expect(hasTeamOwner).not.toHaveBeenCalled();
});

it('concurrent recovered stops share one native request and one exit confirmation', async () => {
  let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; });
  let live = true;
  const stop = vi.fn(async () => { await held; live = false; });
  const owner = new RecoveredConversationStop(async () => ({ list: async () => live ? [target] : [], stop }), () => {});
  const first = owner.stop('project', 'conversation'); const second = owner.stop('project', 'conversation');
  expect(first).toBe(second);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(owner.view('project', 'conversation')).toMatchObject({ running: true, sendable: false, activeProcessId: target.id });
  finish(); await Promise.all([first, second]);
  expect(owner.view('project', 'conversation')).toBeNull();
});

it('a successful native stop receipt cannot turn a still-live process into success', async () => {
  const stop = vi.fn(async () => {}); const pause = vi.fn(async () => {});
  const owner = new RecoveredConversationStop(async () => ({ list: async () => [target], stop }), () => {}, pause);
  await expect(owner.stop('project', 'conversation')).rejects.toThrow('尚未确认旧执行进程退出');
  expect(stop).toHaveBeenCalledTimes(1); expect(pause).toHaveBeenCalledTimes(100);
  expect(owner.isHeld('project', 'conversation')).toBe(true);
  expect(owner.view('project', 'conversation')).toMatchObject({ running: true, error: true, sendable: false });
});

it('an unavailable native list remains a failure until an explicit successful retry', async () => {
  const list = vi.fn<[], Promise<readonly LiveProcessInfo[]>>().mockRejectedValueOnce(new Error('native list unavailable')).mockResolvedValue([]);
  const stop = vi.fn(async () => {});
  const owner = new RecoveredConversationStop(async () => ({ list, stop }), () => {});
  await expect(owner.stop('project', 'conversation')).rejects.toThrow('native list unavailable');
  expect(owner.isHeld('project', 'conversation')).toBe(true);
  await owner.stop('project', 'conversation');
  expect(owner.isHeld('project', 'conversation')).toBe(false); expect(stop).not.toHaveBeenCalled();
});

it('independent native exit confirmation settles a refusal racing natural process exit', async () => {
  let reads = 0;
  const owner = new RecoveredConversationStop(async () => ({ list: async () => ++reads === 1 ? [target] : [],
    stop: async () => { throw new Error('already exiting'); } }), () => {});
  await expect(owner.stop('project', 'conversation')).resolves.toBeUndefined();
  expect(owner.isHeld('project', 'conversation')).toBe(false);
});

it('bulk stop refuses a root whose conversation ownership is missing', async () => {
  const stop = vi.fn(async () => {});
  const owner = new RecoveredConversationStop(async () => ({ list: async () => [{ ...target, metadata: {} }], stop }), () => {});
  await expect(owner.stopAll(new Set())).rejects.toThrow('缺少工作区或会话归属');
  expect(stop).not.toHaveBeenCalled();
});

it('bulk discovery blocks a new send before the native list answers', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const owner = new RecoveredConversationStop(async () => ({ list: async () => { await held; return []; }, stop: async () => {} }), () => {});
  const pending = owner.stopAll(new Set());
  try { expect(owner.isHeld('project', 'conversation')).toBe(true); }
  finally { release(); await pending; }
  expect(owner.isHeld('project', 'conversation')).toBe(false);
});

it('bulk discovery never passes an already-owned native id into detached cleanup', async () => {
  const owned = { ...target, id: 'owned-root' as ProcessId };
  const live = new Map([[target.id, target], [owned.id, owned]]);
  const stop = vi.fn(async (id: ProcessId) => { live.delete(id); });
  const owner = new RecoveredConversationStop(async () => ({ list: async () => [...live.values()], stop }), () => {});
  await owner.stopAll(new Set([owned.id]));
  expect(stop).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalledWith(target.id);
  expect(live.has(owned.id)).toBe(true);
});

it('a bulk child failure stays owned by that conversation and a local retry clears it', async () => {
  let live = true; let refused = true;
  const owner = new RecoveredConversationStop(async () => ({ list: async () => live ? [target] : [],
    stop: async () => { if (refused) throw new Error('native refusal'); live = false; } }), () => {});
  await expect(owner.stopAll(new Set())).rejects.toThrow('native refusal');
  expect(owner.isHeld('project', 'conversation')).toBe(true);
  expect(owner.isHeld('unrelated-project', 'other')).toBe(false);
  refused = false; await owner.stop('project', 'conversation');
  expect(owner.isHeld('project', 'conversation')).toBe(false);
});

it('ownership inspection excludes current controller ids and unrelated conversation roots', async () => {
  const stop = vi.fn(async () => {});
  const sibling = { ...target, id: 'sibling' as ProcessId, metadata: { ...target.metadata, conversationId: 'other' } };
  const owner = new RecoveredConversationStop(async () => ({ list: async () => [target, sibling], stop }), () => {});
  await owner.assertAvailable('project', 'conversation', new Set([target.id]));
  expect(owner.isHeld('project', 'conversation')).toBe(false); expect(stop).not.toHaveBeenCalled();
});

it('Stop arriving during inspection performs actual cleanup after the read-only result', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let first = true; let live = true;
  const stop = vi.fn(async () => { live = false; });
  const owner = new RecoveredConversationStop(async () => ({ list: async () => {
    if (first) { first = false; await held; } return live ? [target] : [];
  }, stop }), () => {});
  const inspection = expect(owner.assertAvailable('project', 'conversation', new Set())).rejects.toThrow('旧执行');
  const stopping = owner.stop('project', 'conversation');
  release(); await Promise.all([inspection, stopping]);
  expect(stop).toHaveBeenCalledTimes(1); expect(owner.isHeld('project', 'conversation')).toBe(false);
});

it('inspection queued behind Stop checks again for a newly appeared native owner', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const stopping = new Promise<void>(resolve => { entered = resolve; });
  const live = new Map([[target.id, target]]);
  const owner = new RecoveredConversationStop(async () => ({ list: async () => [...live.values()], stop: async () => {
    entered(); await held; live.delete(target.id);
    const replacement = { ...target, id: 'later-root' as ProcessId }; live.set(replacement.id, replacement);
  } }), () => {});
  const stopped = owner.stop('project', 'conversation'); await stopping;
  const inspection = owner.assertAvailable('project', 'conversation', new Set());
  release(); await stopped;
  await expect(inspection).rejects.toThrow('旧执行');
});
