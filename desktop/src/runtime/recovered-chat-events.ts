import { applyEvents } from '../components/chat/events';
import type { ChatMessage } from '../components/chat/types';
import type { LoopEvent } from '../host-adapter/loop-events';

/** Scope replay to its original human turn, even when a later turn is visible. */
export function applyRecoveredChatEvents(messages: readonly ChatMessage[], events: readonly LoopEvent[], turnId: string): ChatMessage[] {
  const start = messages.findIndex(message => message.kind === 'text' && message.role === 'user' && message.turnId === turnId);
  if (start < 0 || events.length === 0) return [...messages];
  const later = messages.findIndex((message, index) => index > start && message.kind === 'text'
    && message.role === 'user' && message.steerState === undefined);
  const end = later < 0 ? messages.length : later;
  return [...messages.slice(0, start), ...applyEvents(messages.slice(start, end), events), ...messages.slice(end)];
}
