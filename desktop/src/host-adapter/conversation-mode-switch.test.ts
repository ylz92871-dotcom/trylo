import { describe, expect, it } from 'vitest';
import {
  createConversation,
  emptyWorkspaceHistory,
  normalizeWorkspaceHistory,
  renameConversation,
  selectConversation,
  switchConversationKind,
  updateConversationDraft,
  updateConversationMessages,
  type ConversationKind,
} from './conversation-history';

function seed(from: ConversationKind) {
  const oldCode = createConversation(emptyWorkspaceHistory(), { kind: 'code', now: 100 });
  const oldWork = createConversation(oldCode.history, { kind: 'work', now: 200 });
  const fresh = createConversation(oldWork.history, { kind: from, codeMode: 'plan', now: 300 });
  return { oldCode, oldWork, fresh };
}

describe('composer conversation type switching', () => {
  it.each(['code', 'work'] as const)('keeps a new %s chat when switching, instead of opening the old target chat', (from) => {
    const to = from === 'code' ? 'work' : 'code';
    const { oldCode, oldWork, fresh } = seed(from);
    const draft = updateConversationDraft(fresh.history, fresh.session.id, 'Unsent task');
    const switched = switchConversationKind(draft, { from, to, codeMode: 'plan', canReuse: true, now: 400 });
    expect(switched.activeByKind).toEqual({ [from]: null, [to]: fresh.session.id });
    expect(switched.conversations[fresh.session.id]).toMatchObject({
      draft: 'Unsent task', messages: [], session: {
        id: fresh.session.id, kind: to, mode: to === 'work' ? 'office' : 'plan',
        title: to === 'work' ? '新工作任务' : '新任务', codeMode: 'plan',
      },
    });
    expect(switched.conversations[oldCode.session.id]).toBe(fresh.history.conversations[oldCode.session.id]);
    expect(switched.conversations[oldWork.session.id]).toBe(fresh.history.conversations[oldWork.session.id]);
    expect(Object.keys(switched.conversations)).toHaveLength(3);

    const reloaded = normalizeWorkspaceHistory(JSON.parse(JSON.stringify(switched)));
    const back = switchConversationKind(reloaded, { from: to, to: from, codeMode: 'plan', canReuse: true });
    expect(back.activeByKind[from]).toBe(fresh.session.id);
    expect(back.conversations[fresh.session.id]?.draft).toBe('Unsent task');
    expect(Object.keys(back.conversations)).toHaveLength(3);
    // History selection remains an explicit way to return to an old chat.
    expect(selectConversation(back, oldWork.session.id).activeByKind.work).toBe(oldWork.session.id);
  });

  it.each(['code', 'work'] as const)('preserves an established %s transcript and opens a fresh target chat', (from) => {
    const to = from === 'code' ? 'work' : 'code';
    const { fresh } = seed(from);
    const history = updateConversationMessages(fresh.history, fresh.session.id, [
      { id: 'u1', kind: 'text', role: 'user', text: 'Existing task', createdAt: 301 },
    ]);
    const switched = switchConversationKind(history, { from, to, codeMode: 'agent', canReuse: true });
    expect(switched.conversations[fresh.session.id]).toBe(history.conversations[fresh.session.id]);
    expect(switched.activeByKind[from]).toBe(fresh.session.id);
    expect(switched.activeByKind[to]).not.toBe(history.activeByKind[to]);
    expect(switched.conversations[switched.activeByKind[to]!]).toMatchObject({ messages: [], draft: '', session: { kind: to } });
  });

  it('leaves runtime and attachment owners intact when the composer cannot reuse the source', () => {
    const { fresh } = seed('code');
    const source = updateConversationDraft(fresh.history, fresh.session.id, 'With attachments or a pending run');
    const next = switchConversationKind(source, { from: 'code', to: 'work', codeMode: 'plan', canReuse: false });
    expect(next.conversations[fresh.session.id]).toBe(source.conversations[fresh.session.id]);
    expect(next.activeByKind.code).toBe(fresh.session.id);
    expect(next.activeByKind.work).not.toBe(source.activeByKind.work);
  });

  it('preserves a user-supplied title and ignores selecting the same type', () => {
    const { fresh } = seed('code');
    const history = renameConversation(fresh.history, fresh.session.id, 'My draft');
    expect(switchConversationKind(history, { from: 'code', to: 'code', codeMode: 'plan', canReuse: true })).toBe(history);
    const switched = switchConversationKind(history, { from: 'code', to: 'work', codeMode: 'plan', canReuse: true });
    expect(switched.conversations[fresh.session.id]?.session.title).toBe('My draft');
  });
});
