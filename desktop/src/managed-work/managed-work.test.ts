// Historical managed-session serialization and binding compatibility.
// Run: npx vitest run src/managed-work/managed-work.test.ts

import { describe, expect, it } from 'vitest';
import {
  bindManagedChild,
  deserializeManagedChildBindings,
  emptyManagedChildBindings,
  findBySessionId,
  findByToolUseId,
  isTerminalStatus,
  listActive,
  reconcileManagedChild,
  removeBinding,
  serializeManagedChildBindings,
  updateStatus,
  type ManagedChildBindings,
} from './managed-child-binding';
import type { ManagedChildBinding } from './managedWorkTypes';
function makeBinding(overrides: Partial<ManagedChildBinding> = {}): ManagedChildBinding {
  return {
    childId: 'managed-sess-1',
    projectKey: 'D:/ws',
    conversationId: 'conv-1',
    parentRunId: 'run-1',
    parentToolUseId: 'tool-use-1',
    managedSessionId: 'sess-1',
    backingTaskId: 'task-1',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('bindManagedChild (§7.3: uniqueness + idempotent replay)', () => {
  it('binds a new parent tool-use → session', () => {
    const { next, binding } = bindManagedChild(emptyManagedChildBindings(), makeBinding());
    expect(binding.managedSessionId).toBe('sess-1');
    expect(next['sess-1']).toBe(binding);
  });

  it('replaying the SAME parentToolUseId returns the original binding (never a second session)', () => {
    let store: ManagedChildBindings = {};
    ({ next: store } = bindManagedChild(store, makeBinding({ managedSessionId: 'sess-1' })));
    const replayCandidate = makeBinding({
      parentToolUseId: 'tool-use-1',
      managedSessionId: 'sess-DIFFERENT',
      childId: 'managed-sess-DIFFERENT',
    });
    const { next, binding } = bindManagedChild(store, replayCandidate);
    expect(binding.managedSessionId).toBe('sess-1'); // original wins
    expect(next['sess-DIFFERENT']).toBeUndefined(); // no second session
    expect(Object.keys(next)).toHaveLength(1);
  });

  it('one session maps to exactly one binding (uniqueness by managedSessionId)', () => {
    let store: ManagedChildBindings = {};
    ({ next: store } = bindManagedChild(store, makeBinding()));
    const otherParent = makeBinding({ parentToolUseId: 'tool-use-2', managedSessionId: 'sess-1' });
    const { next, binding } = bindManagedChild(store, otherParent);
    expect(binding.parentToolUseId).toBe('tool-use-1'); // existing binding wins
    expect(Object.keys(next)).toHaveLength(1);
  });

  it('findByToolUseId / findBySessionId / listActive / updateStatus / removeBinding', () => {
    let store: ManagedChildBindings = {};
    ({ next: store } = bindManagedChild(store, makeBinding()));
    ({ next: store } = bindManagedChild(
      store,
      makeBinding({ parentToolUseId: 'tool-use-2', managedSessionId: 'sess-2', status: 'completed' }),
    ));

    expect(findByToolUseId(store, 'tool-use-1')?.managedSessionId).toBe('sess-1');
    expect(findBySessionId(store, 'sess-2')?.status).toBe('completed');

    // Only sess-1 is active (sess-2 is terminal).
    const active = listActive(store);
    expect(active).toHaveLength(1);
    expect(active[0]?.managedSessionId).toBe('sess-1');

    store = updateStatus(store, 'sess-1', 'waiting');
    expect(findBySessionId(store, 'sess-1')?.status).toBe('waiting');

    store = removeBinding(store, 'sess-1');
    expect(findBySessionId(store, 'sess-1')).toBeUndefined();
    expect(Object.keys(store)).toHaveLength(1);
  });
});

describe('reconcileManagedChild (§8.2 recovery rules)', () => {
  it('terminal bindings are not re-fetched', async () => {
    const binding = makeBinding({ status: 'completed' });
    const out = await reconcileManagedChild(binding, async () => {
      throw new Error('must not be called');
    });
    expect(out.status).toBe('completed');
  });

  it('daemon authoritative status wins', async () => {
    const out = await reconcileManagedChild(makeBinding({ status: 'running' }), async () => ({
      ok: true as const,
      status: 'completed',
    }));
    expect(out.status).toBe('completed');
  });

  it('backing task missing → orphaned (never permanently running)', async () => {
    const out = await reconcileManagedChild(makeBinding({ status: 'running' }), async () => ({
      ok: false as const,
      reason: 'not_found' as const,
    }));
    expect(out.status).toBe('orphaned');
  });

  it('daemon unreachable → unavailable (no fabricated replacement)', async () => {
    const out = await reconcileManagedChild(makeBinding({ status: 'running' }), async () => ({
      ok: false as const,
      reason: 'unavailable' as const,
    }));
    expect(out.status).toBe('unavailable');
  });
});

describe('serialization (whitelist, backwards compatible)', () => {
  it('round-trips bindings', () => {
    const store: ManagedChildBindings = {};
    const { next } = bindManagedChild(store, makeBinding());
    const json = serializeManagedChildBindings(next);
    const restored = deserializeManagedChildBindings(json);
    expect(restored['sess-1']?.parentToolUseId).toBe('tool-use-1');
    expect(restored['sess-1']?.backingTaskId).toBe('task-1');
  });

  it('drops junk and entries whose key mismatches managedSessionId', () => {
    const restored = deserializeManagedChildBindings({
      'sess-1': { parentToolUseId: 't1', managedSessionId: 'sess-1', status: 'running', createdAt: 1, updatedAt: 1 },
      'bad': 'not-an-object',
      'mismatch': { parentToolUseId: 't2', managedSessionId: 'OTHER' },
    });
    expect(Object.keys(restored)).toEqual(['sess-1']);
  });

  it('undefined / non-object → empty store', () => {
    expect(deserializeManagedChildBindings(undefined)).toEqual({});
    expect(deserializeManagedChildBindings([1, 2])).toEqual({});
  });
});

describe('isTerminalStatus', () => {
  it('terminal vs not', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('waiting')).toBe(false);
    expect(isTerminalStatus('orphaned')).toBe(false);
    expect(isTerminalStatus('unavailable')).toBe(false);
  });
});
