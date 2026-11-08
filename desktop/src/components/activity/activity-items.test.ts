import { describe, expect, it, vi } from 'vitest';
import { buildActivityItems } from './activity-items';
import { emptyWorkspaceHistory, workspaceKey, type WorkspaceConversationHistory } from '../../host-adapter/conversation-history';
import type { ActiveCodeRun } from '../../runtime/runtime-types';

const workspaces = [{ id: 'a', root: 'D:/Code', name: '项目 A' }, { id: 'b', root: 'D:/Reports', name: '项目 B' }];
function history(kind: 'code' | 'work', title: string): WorkspaceConversationHistory {
  return { ...emptyWorkspaceHistory(), conversations: { same: { draft: '', messages: [], session: { id: 'same', kind, title, mode: kind === 'code' ? 'agent' : 'office', createdAt: 1, updatedAt: 1, turnCount: 0, ...(kind === 'code' ? { codeMode: 'plan' as const } : {}) } } } };
}
const runs: ActiveCodeRun[] = workspaces.map(w => ({ projectKey: workspaceKey(w.root), conversationId: 'same', runId: 'turn', startedAt: 100, bindingState: 'busy' }));
const histories = { 'd:/code': history('code', '修复导出'), 'd:/reports': history('work', '核对报告') };
describe('Activity item projection', () => {
  it('includes all workspaces, resolves each title and preserves Code/Work identity', () => {
    const items = buildActivityItems({ runs, workspaces, histories, onStop: vi.fn(), onJump: vi.fn() });
    expect(items.map(i => [i.title, i.kind, i.workspaceLabel])).toEqual([['修复导出', 'code', '项目 A'], ['核对报告', 'work', '项目 B']]);
    expect(new Set(items.map(i => i.id)).size).toBe(2);
  });
  it('routes a Work jump to its own workspace and complete session instead of Code', () => {
    const jump = vi.fn(); const items = buildActivityItems({ runs, workspaces, histories, onStop: vi.fn(), onJump: jump });
    items[1]!.onJump?.(); expect(jump).toHaveBeenCalledWith({ workspace: workspaces[1], session: histories['d:/reports'].conversations.same!.session });
    items[0]!.onJump?.(); expect(jump.mock.calls[1]![0].session.codeMode).toBe('plan');
  });
  it('stops using the exact original project/conversation identity and returns its receipt', async () => {
    const stop = vi.fn(async () => {}); const items = buildActivityItems({ runs, workspaces, histories, onStop: stop, onJump: vi.fn() });
    await items[1]!.onStop(); expect(stop).toHaveBeenCalledWith('d:/reports', 'same');
  });
  it('does not hide a live run when metadata is absent or invent a mode/jump target', () => {
    const items = buildActivityItems({ runs, workspaces: [], histories: {}, onStop: vi.fn(), onJump: vi.fn() });
    expect(items).toHaveLength(2); expect(items[0]!.kind).toBe('unknown'); expect(items[0]!.onJump).toBeUndefined(); expect(items[0]!.statusLabel).toContain('暂不可用');
  });
  it('preserves stop errors for the UI to report', async () => {
    const stop = vi.fn(async () => { throw Error('stop rejected'); }); const items = buildActivityItems({ runs, workspaces, histories, onStop: stop, onJump: vi.fn() });
    await expect(items[0]!.onStop()).rejects.toThrow('stop rejected');
  });
});
