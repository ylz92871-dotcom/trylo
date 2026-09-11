// Trylo Desktop — managed-child binding ↔ conversation-history persistence
// (P3 §7.3). Run: npx vitest run src/host-adapter/conversation-history-managed.test.ts

import { describe, expect, it } from 'vitest';
import {
  bindManagedChildToConversation,
  emptyWorkspaceHistory,
  managedChildrenForConversation,
  normalizeWorkspaceHistory,
  type WorkspaceConversationHistory,
} from './conversation-history';
import type { ManagedChildBinding } from '../managed-work/managedWorkTypes';

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

function historyWithConversation(): WorkspaceConversationHistory {
  const history = emptyWorkspaceHistory();
  return {
    ...history,
    conversations: {
      'conv-1': {
        session: {
          id: 'conv-1',
          title: 'Work',
          mode: 'office',
          kind: 'work',
          createdAt: 1,
          updatedAt: 1,
          turnCount: 0,
        },
        messages: [],
        draft: '',
      },
    },
  };
}

describe('bindManagedChildToConversation (§7.3, persisted via history)', () => {
  it('binds a new child and exposes it through managedChildrenForConversation', () => {
    const history = bindManagedChildToConversation(historyWithConversation(), 'conv-1', makeBinding());
    const children = managedChildrenForConversation(history, 'conv-1');
    expect(children['sess-1']?.parentToolUseId).toBe('tool-use-1');
    expect(children['sess-1']?.backingTaskId).toBe('task-1');
  });

  it('replaying the same parentToolUseId returns the SAME history (no second session)', () => {
    const once = bindManagedChildToConversation(historyWithConversation(), 'conv-1', makeBinding());
    const replayCandidate = makeBinding({ managedSessionId: 'sess-DIFFERENT', childId: 'managed-sess-DIFFERENT' });
    const replayed = bindManagedChildToConversation(once, 'conv-1', replayCandidate);
    expect(replayed).toBe(once); // unchanged reference → caller skips save
    expect(managedChildrenForConversation(replayed, 'conv-1')['sess-DIFFERENT']).toBeUndefined();
  });

  it('unknown conversation is a no-op', () => {
    const history = historyWithConversation();
    expect(bindManagedChildToConversation(history, 'missing', makeBinding())).toBe(history);
  });
});

describe('persistence round-trip through normalizeWorkspaceHistory', () => {
  it('keeps managedChildren across save → load (whitelist)', () => {
    const bound = bindManagedChildToConversation(historyWithConversation(), 'conv-1', makeBinding());
    // Simulate a disk round-trip: the JSON is what normalize reads back.
    const loaded = normalizeWorkspaceHistory(bound);
    const children = managedChildrenForConversation(loaded, 'conv-1');
    expect(children['sess-1']?.status).toBe('running');
    expect(children['sess-1']?.managedSessionId).toBe('sess-1');
  });

  it('strips junk entries on load', () => {
    const withJunk = {
      version: 1 as const,
      activeByKind: { code: null, work: 'conv-1' },
      conversations: {
        'conv-1': {
          session: {
            id: 'conv-1', title: 'Work', mode: 'office', kind: 'work',
            createdAt: 1, updatedAt: 1, turnCount: 0,
          },
          messages: [],
          draft: '',
          managedChildren: {
            'sess-1': {
              parentToolUseId: 't1', managedSessionId: 'sess-1', status: 'running', createdAt: 1, updatedAt: 1,
            },
            'junk': { parentToolUseId: 't2', managedSessionId: 'OTHER' },
          },
        },
      },
    };
    const loaded = normalizeWorkspaceHistory(withJunk);
    const children = managedChildrenForConversation(loaded, 'conv-1');
    expect(Object.keys(children)).toEqual(['sess-1']);
  });

  it('history without managedChildren stays unchanged (backwards compatible)', () => {
    const plain = normalizeWorkspaceHistory(historyWithConversation());
    expect(managedChildrenForConversation(plain, 'conv-1')).toEqual({});
  });
});
