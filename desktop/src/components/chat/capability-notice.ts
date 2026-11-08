import type { ChatMessage } from './types';

/** Retire old ambient configuration banners. User text, blocked requests and
 * runtime/tool failures retain their original identities and contents. */
export function omitOptionalCapabilityNotices(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  const filtered = messages.filter(message => {
    if (message.kind !== 'notice' || message.role !== 'system'
      || !message.id.startsWith('work-cap-')) return true;
    return !message.text.startsWith('本次运行缺少可选工具：')
      && !message.text.startsWith('本次运行有工具不可用：');
  });
  return filtered.length === messages.length ? messages : filtered;
}
