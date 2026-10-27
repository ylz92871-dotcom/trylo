import { describe, expect, it } from 'vitest';
import { memberTranscript } from './member-transcript';
import type { SubagentMessage } from './types';
import { recordMemberObservation } from '../../domain/member-observation';

const member: SubagentMessage = { id: 'agent', kind: 'subagent', role: 'system', createdAt: 1, status: 'waiting', agentType: 'worker', round: 1,
  conversation: [{ round: 1, prompt: 'Read the entry', result: 'aggregated raw answer' }] };
describe('personal conversation messages for every member', () => {
  it('preserves actual text/tool/text order and does not repeat the aggregated result', () => {
    let observations = recordMemberObservation([], { id: 'intro', round: 1, kind: 'text', text: '先读取入口。' }, 2);
    observations = recordMemberObservation(observations, { id: 'read', round: 1, kind: 'tool', tool: 'read_file', input: { path: 'entry.ts' } }, 3);
    observations = recordMemberObservation(observations, { id: 'read', round: 1, kind: 'result', ok: false, text: 'not found' }, 4);
    observations = recordMemberObservation(observations, { id: 'answer', round: 1, kind: 'text', text: '路径不存在，需要核对。' }, 5);
    const messages = memberTranscript({ ...member, observations });
    expect(messages.map(message => message.kind)).toEqual(['text', 'text', 'tool', 'text']);
    expect(messages[2]).toMatchObject({ status: 'error', input: { path: 'entry.ts' }, outputText: 'not found', durationMs: 1 });
    expect(messages.flatMap(message => message.kind === 'text' ? [message.text] : [])).not.toContain('aggregated raw answer');
  });
  it('retains legacy answers and a later local instruction in the member conversation', () => {
    const messages = memberTranscript({ ...member, round: 2, conversation: [
      ...member.conversation!, { round: 2, prompt: 'Check only spaces', result: 'Space check complete' },
    ] });
    expect(messages.flatMap(message => message.kind === 'text' ? [message.text] : [])).toEqual(['Read the entry', 'aggregated raw answer', 'Check only spaces', 'Space check complete']);
  });
});
