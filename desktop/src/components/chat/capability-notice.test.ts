import { describe, expect, it } from 'vitest';
import { createConversation, emptyWorkspaceHistory, normalizeWorkspaceHistory, updateConversationMessages } from '../../host-adapter/conversation-history';
import type { ChatMessage } from './types';

describe('Work capability configuration notices', () => {
  it('omits old optional-tool configuration banners across sends and restores while retaining failures', () => {
    const created = createConversation(emptyWorkspaceHistory(), { kind: 'work', now: 1 });
    const optional = '本次运行缺少可选工具：Chrome。可在 设置 → Work 工具 安装；本次先以现有能力继续。';
    const notice = (id: string, text: string): ChatMessage => ({ id, text, kind: 'notice', role: 'system', createdAt: 2 });
    const first = updateConversationMessages(created.history, created.session.id, [notice('work-cap-first', optional)]);
    const messages = [
      ...first.conversations[created.session.id]!.messages,
      { id: 'user', kind: 'text', role: 'user', createdAt: 3, text: optional } as ChatMessage,
      notice('work-cap-second', optional),
      notice('work-cap-changed', optional.replace('Chrome', 'KiCad')),
      notice('work-cap-current', '本次运行有工具不可用：KiCad 自动化、FreeCAD 自动化、Blender 自动化。'),
      notice('warn-one', 'denied'), notice('warn-two', 'denied'),
      notice('work-cap-block-one', '您的请求需要的能力当前不可用：Chrome。'),
      notice('work-cap-block-two', '您的请求需要的能力当前不可用：Chrome。'),
    ];
    const assertProjection = (projected: readonly ChatMessage[]) => {
      expect(projected.map(message => message.id)).toEqual([
        'user', 'warn-one', 'warn-two',
        'work-cap-block-one', 'work-cap-block-two',
      ]);
    };
    const saved = updateConversationMessages(first, created.session.id, messages);
    assertProjection(saved.conversations[created.session.id]!.messages);
    const restored = normalizeWorkspaceHistory({ ...first, conversations: {
      [created.session.id]: { ...first.conversations[created.session.id], messages },
    } });
    assertProjection(restored.conversations[created.session.id]!.messages);
  });
});
