import { describe, expect, it } from 'vitest';
import { TryloV1EventAdapter } from './trylo-v1-event-adapter';
import { parseCliV1Event } from './trylo-v1-protocol';
import { applyEvents } from '../components/chat/events';
import type { ChatMessage } from '../components/chat/types';
import { applyTeamEvents } from '../surfaces/team/team-projection';
import { FIXTURE_TEAM_RUN } from '../surfaces/team/team-fixture';

const spawn = { type: 'subagent', kind: 'spawn', id: 'worker-a', agentType: 'worker', status: 'running' };
describe('V1 child lifecycle truth', () => {
  it('does not mistake an ordinary worker for a legacy Team seat', () => {
    const adapter = new TryloV1EventAdapter();
    const events = adapter.feed(JSON.stringify(spawn));
    const messages: ChatMessage[] = [{ id: 'u', kind: 'text', role: 'user', createdAt: 1, text: 'work' }];
    expect(applyEvents(messages, events).some(message => message.kind === 'subagent')).toBe(true);
    const run = { ...FIXTURE_TEAM_RUN, personConversationId: 'p', workspaceId: 'w' };
    expect(applyTeamEvents(run, events, { workspaceId: 'w', personConversationId: 'p' })).toBe(run);
  });
  it('does not report overall completion with an unclosed child lifecycle', () => {
    const adapter = new TryloV1EventAdapter();
    adapter.feed(JSON.stringify(spawn));
    const terminal = adapter.feed(JSON.stringify({ type: 'run_result', status: 'completed', finishReason: 'stop',
      sessionId: 's', turnId: 't', iterations: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: 1, lastMessage: 'done' }));
    expect(adapter.summary().outcome).toBe('unknown');
    expect(terminal).toContainEqual(expect.objectContaining({ type: 'runtime_warning', code: 'incomplete_subagent_stream' }));
    expect(terminal).toContainEqual(expect.objectContaining({ type: 'subagent', kind: 'end', status: 'failed' }));
  });
  it('rejects impossible state combinations and malformed round fields', () => {
    for (const change of [{ kind: 'end', status: 'running' }, { kind: 'update', status: 'done' }, { kind: 'update', status: 'waiting', round: -1 }]) {
      expect(parseCliV1Event(JSON.stringify({ ...spawn, ...change }))).toMatchObject({ ok: false, reason: 'invalid_fields' });
    }
  });
});
