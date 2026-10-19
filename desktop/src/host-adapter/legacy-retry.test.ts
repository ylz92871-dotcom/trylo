import { describe, expect, it } from 'vitest';
import { StreamTranslator } from './stream-translator';
import { applyEvents } from '../components/chat/events';
import { deriveConversationRunViewState } from '../components/chat/view-state';
import type { ChatMessage } from '../components/chat/types';

const user: ChatMessage = { id: 'user-1', kind: 'text', role: 'user', text: 'hello', createdAt: 1 };
const retry = (status: number) => ({ type: 'system', subtype: 'api_retry', attempt: 1,
  max_retries: 10, retry_delay_ms: 1500, error_status: status, error: 'provider detail must not be shown' });

describe('legacy retries reach the conversation', () => {
  it.each([401, 403])('stops HTTP %s immediately and shows the reason without provider secrets', status => {
    const events = new StreamTranslator().feed(JSON.stringify(retry(status)));
    expect(events.map(event => event.type)).toEqual(['api_retry', 'runtime_warning', 'aborted']);
    const messages = applyEvents([user], events);
    const notice = messages.find(message => message.kind === 'notice');
    expect(notice).toMatchObject({ role: 'system', text: expect.stringContaining(`HTTP ${status}`) });
    expect(JSON.stringify(messages)).not.toContain('provider detail');
    expect(events.at(-1)).toMatchObject({ reason: 'error' });
  });
  it('shows bounded retry progress, enters reconnecting, and clears it when output resumes', () => {
    const translator = new StreamTranslator();
    let messages = applyEvents([user], translator.feed(JSON.stringify(retry(429))));
    messages = applyEvents(messages, translator.feed(JSON.stringify({ ...retry(429), attempt: 2 })));
    expect(messages.filter(message => message.kind === 'notice')).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ text: expect.stringContaining('2/10') });
    expect(deriveConversationRunViewState({ messages, running: true })).toBe('reconnecting');
    const nextUser: ChatMessage = { ...user, id: 'user-2', createdAt: 2 };
    expect(deriveConversationRunViewState({ messages: [...messages, nextUser], running: true })).toBe('waiting_first_output');
    messages = applyEvents(messages, [{ type: 'text', seq: 10, ts: 10, turn: 1, preview: 'ready', partial: true }]);
    expect(messages.filter(message => message.kind === 'notice')).toHaveLength(0);
    expect(deriveConversationRunViewState({ messages, running: true })).toBe('finalizing');
  });
});
