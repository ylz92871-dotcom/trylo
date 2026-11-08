import type { ChatMessage } from '../types';

export interface ShelfEntry {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
}

/** Navigation projects existing messages; it never invents a turn or edits history. */
export function conversationEntries(messages: readonly ChatMessage[]): readonly ShelfEntry[] {
  const entries: { id: string; title: string; excerpt: string }[] = [];
  const byId = new Map<string, { id: string; title: string; excerpt: string }>();
  for (const message of messages) {
    if (message.kind !== 'text') continue;
    if (message.role === 'user') {
      const entry = {
        id: message.id,
        title:
          message.text.trim() ||
          message.attachments?.map((item) => item.name).join('、') ||
          '附件消息',
        excerpt: '',
      };
      entries.push(entry);
      byId.set(entry.id, entry);
    } else if (message.role === 'assistant' && message.text.trim()) {
      const entry = message.turnId ? byId.get(message.turnId) : entries.at(-1);
      if (entry) entry.excerpt = message.text;
    }
  }
  return entries;
}

export interface IndexedShelfEntry extends ShelfEntry {
  readonly index: number;
}

export function entryAtRow(entries: readonly IndexedShelfEntry[], index: number): string | null {
  let current = entries[0]?.id ?? null;
  for (const entry of entries) {
    if (entry.index > index) break;
    current = entry.id;
  }
  return current;
}
