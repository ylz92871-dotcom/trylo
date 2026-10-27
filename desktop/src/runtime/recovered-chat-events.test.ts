import { expect, it } from 'vitest';
import { applyRecoveredChatEvents } from './recovered-chat-events';
import { TryloV1EventAdapter } from '../host-adapter/trylo-v1-event-adapter';
import type { ChatMessage } from '../components/chat/types';

it('replays to the originating user turn without duplicating text or touching later human input', () => {
  const adapter = new TryloV1EventAdapter();
  const events = ['message_start', 'message_delta', 'message_end'].flatMap(type => adapter.feed(JSON.stringify({ type, text: 'restored result' })));
  const user: ChatMessage = { id: 'user-old', role: 'user', kind: 'text', text: 'team goal', createdAt: 1, turnId: 'turn-old' };
  const later: ChatMessage = { id: 'user-new', role: 'user', kind: 'text', text: 'next question', createdAt: 3, turnId: 'turn-new' };
  const initial = [user, later];
  const once = applyRecoveredChatEvents(initial, events, 'turn-old');
  const twice = applyRecoveredChatEvents(once, events, 'turn-old');
  expect(twice).toEqual(once);
  expect(twice.at(-1)).toBe(later);
  expect(twice.filter(message => message.role === 'assistant')).toHaveLength(1);
  expect(applyRecoveredChatEvents(initial, events, 'missing')).toEqual(initial);
});
