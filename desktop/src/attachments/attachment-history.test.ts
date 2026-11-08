import { describe, expect, it, vi } from 'vitest';
import type { TextMessage } from '../components/chat/types';
import { buildBootstrapUserPrompt } from '../host-adapter/trylo-v1-runner';
import { attachmentHistoryContent, failedAttachmentRetry, prepareWorkAttachmentRetry, recoverWorkAttachmentHistory } from './attachment-history';
import { formatAttachmentMessage } from './attachment-message';
import { toWorkDescriptor, type WorkAttachmentEntry } from './attachment-acquisition';
import { createConversation, emptyWorkspaceHistory, normalizeWorkspaceHistory, updateConversationMessages } from '../host-adapter/conversation-history';

const failed: TextMessage = { id: 'first', kind: 'text', role: 'user', createdAt: 1,
  text: '用这三张照片制作作业', turnTiming: { elapsedMs: 5000, outcome: 'failed' },
  attachments: ['a', 'b', 'c'].map(id => ({ id, name: `${id}.png`, kind: 'image', size: 100 })) };

describe('attachment context across a failed send and continuation', () => {
  it('recovers legacy chips and includes all three real file references in bootstrap history', async () => {
    const statFile = vi.fn(async () => ({ isFile: true, size: 150 }));
    const continuation: TextMessage = { id: 'next', kind: 'text', role: 'user', createdAt: 2,
      text: '继续', turnTiming: { elapsedMs: 10, outcome: 'failed' } };
    const recovered = await recoverWorkAttachmentHistory({ messages: [failed, continuation],
      conversationId: 'session', workspaceRoot: 'D:/project', statFile });
    expect(statFile).toHaveBeenCalledTimes(3);
    expect(recovered.missingIds.size).toBe(0);
    const retry = failedAttachmentRetry(recovered.messages)!;
    expect(retry.id).toBe('first');
    expect(retry.attachments).toHaveLength(3);
    const prompt = buildBootstrapUserPrompt(recovered.messages, '继续');
    for (const id of ['a', 'b', 'c']) {
      expect(prompt).toContain(`.trylo/attachments/session/${id}/${id}.png`);
      expect(attachmentHistoryContent(retry)).toContain(`media_type: image/png`);
    }
    expect(prompt).toContain(failed.text);
    const frame = JSON.parse(prompt) as { message: { content: unknown }; bootstrap_context: { messages: { role: string; content: string }[] } };
    expect(frame.message.content).toEqual([{ type: 'text', text: '继续' }]);
    expect(frame.bootstrap_context.messages[0]?.content).toContain('path: .trylo/attachments/session/a/a.png');
  });

  it('does not resend a delivered request just because its model run failed later', () => {
    expect(failedAttachmentRetry([{ ...failed, attachmentsAccepted: true }])).toBeUndefined();
    const delivered: TextMessage = { ...failed, id: 'delivered', attachmentsAccepted: true };
    expect(failedAttachmentRetry([failed, delivered])).toBeUndefined();
    const partiallyDelivered = { ...delivered, attachments: [failed.attachments![0]!] };
    expect(failedAttachmentRetry([failed, partiallyDelivered])?.attachments?.map(a => a.id)).toEqual(['b', 'c']);
  });

  it('forwards failed text and photos to a resumed CLI even after draft loss or with retained draft files', async () => {
    const recovered = await recoverWorkAttachmentHistory({ messages: [failed], conversationId: 'session',
      workspaceRoot: 'D:/project', statFile: async () => ({ size: 150, isFile: true }) });
    const args = { text: '继续', messages: recovered.messages, missingIds: recovered.missingIds, workspaceRoot: 'D:/project' };
    const replay = prepareWorkAttachmentRetry({ ...args, attachments: [] })!;
    const content = formatAttachmentMessage({ userText: replay.text, attachments: replay.attachments.map(toWorkDescriptor) });
    expect(content).toContain(failed.text);
    expect(content).toContain('继续');
    for (const id of ['a', 'b', 'c']) expect(content).toContain(`.trylo/attachments/session/${id}/${id}.png`);
    const added: WorkAttachmentEntry = { ...replay.attachments[0]!, id: 'new', name: 'new.png' };
    const draft = [...replay.attachments, added];
    const retained = prepareWorkAttachmentRetry({ ...args, attachments: draft })!;
    expect(retained.attachments).toBe(draft);
    expect(retained.text).toContain(failed.text);
    expect(prepareWorkAttachmentRetry({ ...args, attachments: [added] })).toBeUndefined();
    expect(() => prepareWorkAttachmentRetry({ ...args, missingIds: new Set(['a']), attachments: [] })).toThrow('无法读取');
  });

  it('persists file references and the native receipt across a history round trip', () => {
    const { history, session } = createConversation(emptyWorkspaceHistory(), { kind: 'work', now: 1 });
    const message = { ...failed, attachmentsAccepted: true, attachments: failed.attachments!.map(file => ({ ...file,
      relativePath: `.trylo/attachments/${session.id}/${file.id}/${file.name}`, mediaType: 'image/png' })) };
    const saved = updateConversationMessages(history, session.id, [message]);
    const restored = normalizeWorkspaceHistory(JSON.parse(JSON.stringify(saved))).conversations[session.id]!.messages;
    expect(restored[0]).toMatchObject(message);
    expect(failedAttachmentRetry(restored)).toBeUndefined();
    expect(attachmentHistoryContent(restored[0]!)).toContain(`.trylo/attachments/${session.id}/a/a.png`);
  });

  it('reports missing files and never invents a usable reference from a chip', async () => {
    const result = await recoverWorkAttachmentHistory({ messages: [failed], conversationId: 'session',
      workspaceRoot: 'D:/project', statFile: async () => { throw new Error('missing'); } });
    expect([...result.missingIds]).toEqual(['a', 'b', 'c']);
    expect(attachmentHistoryContent(result.messages[0]!)).toContain('历史附件尚无可读取路径');
    expect(attachmentHistoryContent(result.messages[0]!)).not.toContain('<trylo_attachments>');
  });

  it.each(['../secret.png', 'folder/secret.png', 'bad\\secret.png'])('refuses unsafe legacy filename %s', async name => {
    const statFile = vi.fn();
    const result = await recoverWorkAttachmentHistory({ messages: [{ ...failed, attachments: [{ id: 'a', name, kind: 'image' }] }],
      conversationId: 'session', workspaceRoot: 'D:/project', statFile });
    expect(statFile).not.toHaveBeenCalled();
    expect(result.missingIds.has('a')).toBe(true);
  });

  it('rejects another conversation path and symbolic links', async () => {
    const result = await recoverWorkAttachmentHistory({ messages: [{ ...failed, attachments: [
      { id: 'a', name: 'a.png', kind: 'image', relativePath: '.trylo/attachments/other/a/a.png' },
      { id: 'b', name: 'b.png', kind: 'image' },
    ] }], conversationId: 'session', workspaceRoot: 'D:/project', statFile: async () => ({ size: 5, isFile: true, isSymlink: true }) });
    expect([...result.missingIds]).toEqual(['a', 'b']);
  });

  it('replays Code absolute file paths while ignoring assistant attachment metadata', () => {
    const message = { ...failed, attachments: [{ id: 'photo', name: 'photo.png', kind: 'image' as const, path: 'D:/project/photo.png' }] };
    expect(attachmentHistoryContent(message)).toContain('path: D:/project/photo.png');
    expect(attachmentHistoryContent({ ...message, role: 'assistant' })).toBe(failed.text);
  });
});
