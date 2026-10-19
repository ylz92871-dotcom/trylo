import { describe, expect, it } from 'vitest';
import { createConversation, emptyWorkspaceHistory, normalizeWorkspaceHistory,
  setConversationPermission, switchConversationKind } from './conversation-history';

describe('composer permission choice', () => {
  it.each(['code', 'work'] as const)('creates a %s draft and retains approval across reload', kind => {
    const history = setConversationPermission(emptyWorkspaceHistory(), kind, 'ask');
    const id = history.activeByKind[kind]!;
    expect(history.conversations[id]?.permissionLevel).toBe('ask');
    const restored = normalizeWorkspaceHistory(JSON.parse(JSON.stringify(history)));
    expect(restored.conversations[id]?.permissionLevel).toBe('ask');
    expect(restored.conversations[id]?.messages).toEqual([]);
  });
  it('preserves the choice when a draft changes between Code and Work', () => {
    const history = setConversationPermission(emptyWorkspaceHistory(), 'code', 'ask');
    const id = history.activeByKind.code!;
    const switched = switchConversationKind(history, { from: 'code', to: 'work', codeMode: 'agent', canReuse: true });
    expect(switched.conversations[id]?.permissionLevel).toBe('ask');
  });
  it('does not change another conversation or accept invalid persisted modes', () => {
    const first = setConversationPermission(emptyWorkspaceHistory(), 'code', 'unrestricted');
    const second = createConversation(first, { kind: 'code' });
    const updated = setConversationPermission(second.history, 'code', 'ask');
    expect(updated.conversations[first.activeByKind.code!]?.permissionLevel).toBe('unrestricted');
    expect(updated.conversations[second.session.id]?.permissionLevel).toBe('ask');
    const invalid = { ...updated, conversations: { ...updated.conversations,
      [second.session.id]: { ...updated.conversations[second.session.id], permissionLevel: 'invalid' } } };
    expect(normalizeWorkspaceHistory(invalid).conversations[second.session.id]?.permissionLevel).toBeUndefined();
  });
});
