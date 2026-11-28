import type { ChatMessage, SentAttachment } from '../components/chat/types';
import { attachmentKind, attachmentMediaType } from '../host-adapter/attachment-utils';
import { joinToRoot, type StatFileFn, type WorkAttachmentEntry } from './attachment-acquisition';
import { formatAttachmentMessage } from './attachment-message';

export interface AttachmentHistoryMessage {
  readonly role: string;
  readonly kind: string;
  readonly text?: string;
  readonly attachments?: readonly SentAttachment[];
}

/** Display chips alone are not replayable context. Keep file references on
 *  the user message, including when the first attempt never reached a CLI. */
export function attachmentHistoryContent(message: AttachmentHistoryMessage): string {
  const files = message.role === 'user' ? (message.attachments ?? []) : [];
  const known = files.filter(file => file.relativePath || file.path);
  const text = formatAttachmentMessage({ userText: message.text ?? '', attachments: known.map(file => ({
    id: file.id, name: file.name, relativePath: file.relativePath ?? file.path!,
    mediaType: file.mediaType ?? attachmentMediaType(file.name), size: file.size ?? 0,
  })) });
  const missing = files.filter(file => !file.relativePath && !file.path);
  return missing.length ? `${text}\n\n[历史附件尚无可读取路径：${missing.map(file => file.name).join('、')}]` : text;
}

const safeSegment = (value: string): boolean => value.length > 0 && value !== '.' && value !== '..'
  // eslint-disable-next-line no-control-regex -- Intentionally reject control bytes or strip ANSI escapes.
  && !/[\\/\x00-\x1f]/.test(value);

/** Recover pre-fix Work messages from the conversation-owned staging path.
 *  A legacy filename is never treated as an arbitrary filesystem path. */
export async function recoverWorkAttachmentHistory(args: {
  readonly messages: readonly ChatMessage[];
  readonly conversationId: string;
  readonly workspaceRoot: string;
  readonly statFile: StatFileFn;
}): Promise<{ messages: readonly ChatMessage[]; missingIds: ReadonlySet<string> }> {
  const missingIds = new Set<string>();
  const recovered = new Map<string, SentAttachment>();
  const messages: ChatMessage[] = [];
  for (const message of args.messages) {
    if (message.kind !== 'text' || message.role !== 'user' || !message.attachments?.length) {
      messages.push(message); continue;
    }
    const attachments: SentAttachment[] = [];
    for (const file of message.attachments) {
      const hit = recovered.get(file.id);
      if (hit) { attachments.push({ ...file, ...hit }); continue; }
      const relativePath = `.trylo/attachments/${args.conversationId}/${file.id}/${file.name}`;
      try {
        if (![args.conversationId, file.id, file.name].every(safeSegment)
          || (file.relativePath !== undefined && file.relativePath !== relativePath)) throw new Error('Invalid attachment owner');
        const stat = await args.statFile(joinToRoot(args.workspaceRoot, relativePath));
        if (stat.isFile !== true || stat.isSymlink === true) throw new Error('Attachment is not an ordinary file');
        const restored = { ...file, relativePath, mediaType: file.mediaType ?? attachmentMediaType(file.name), size: stat.size };
        recovered.set(file.id, restored); attachments.push(restored);
      } catch {
        missingIds.add(file.id);
        const { relativePath: _relative, path: _path, ...unavailable } = file;
        void _relative; void _path; // Deliberately discard unreadable location fields.
        attachments.push(unavailable);
      }
    }
    messages.push({ ...message, attachments });
  }
  return { messages, missingIds };
}

/** A failed, never-delivered request must also survive an established CLI
 *  session: that CLI cannot replay a request it never received. */
export function failedAttachmentRetry(messages: readonly ChatMessage[]): Extract<ChatMessage, { kind: 'text' }> | undefined {
  const accepted = new Set<string>();
  for (const message of messages) {
    if (message.kind === 'text' && message.role === 'user'
      && (message.attachmentsAccepted || message.turnTiming?.outcome === 'completed')) {
      for (const file of message.attachments ?? []) accepted.add(file.id);
    }
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.kind === 'text' && message.role === 'user' && message.turnTiming?.outcome === 'failed'
      && !message.attachmentsAccepted && message.attachments?.some(file => !accepted.has(file.id))) {
      return { ...message, attachments: message.attachments.filter(file => !accepted.has(file.id)) };
    }
  }
  return undefined;
}

/** Forward a never-delivered request even when an existing CLI ignores bootstrap
 *  history. Retained draft files and newly added files keep their exact order. */
export function prepareWorkAttachmentRetry(args: {
  readonly text: string;
  readonly messages: readonly ChatMessage[];
  readonly attachments: readonly WorkAttachmentEntry[];
  readonly missingIds: ReadonlySet<string>;
  readonly workspaceRoot: string;
}): { text: string; attachments: readonly WorkAttachmentEntry[] } | undefined {
  const retry = failedAttachmentRetry(args.messages);
  if (!retry?.attachments?.length) return undefined;
  const currentIds = new Set(args.attachments.map(file => file.id));
  if (args.attachments.length && !retry.attachments.every(file => currentIds.has(file.id))) return undefined;
  if (retry.attachments.some(file => args.missingIds.has(file.id) || !file.relativePath))
    throw new Error('之前发送失败的附件已无法读取，请重新添加照片后继续。');
  const attachments = args.attachments.length ? args.attachments : retry.attachments.map(file => ({
    id: file.id, name: file.name, kind: attachmentKind(file.name), relativePath: file.relativePath!,
    sourcePath: joinToRoot(args.workspaceRoot, file.relativePath!),
    mediaType: file.mediaType ?? attachmentMediaType(file.name), size: file.size ?? 0,
    addedAt: Date.now(), ...(file.previewUrl ? { previewUrl: file.previewUrl } : {}),
  }));
  return { attachments,
    text: `${args.text}\n\n上一次未成功发送的消息（仅作历史上下文，以本轮要求为准）：\n${JSON.stringify(retry.text)}` };
}
