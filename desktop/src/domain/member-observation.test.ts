import { describe, expect, it } from 'vitest';
import { parseCliV1Event } from '../host-adapter/trylo-v1-protocol';
import { isMemberObservation, normalizeMemberObservations } from './member-observation';

describe('additive member observation protocol', () => {
  it('accepts the authored CLI report without turning ready into execution completion', () => {
    const observation = { id: 'report', kind: 'report', round: 1, reportState: 'ready', text: '实现已交付，等待独立验证。' };
    const parsed = parseCliV1Event(JSON.stringify({ type: 'subagent', kind: 'update', id: 'child', status: 'running', observation }));
    expect(parsed).toMatchObject({ ok: true, event: { status: 'running', observation } });
    expect(parseCliV1Event(JSON.stringify({ type: 'subagent', kind: 'update', id: 'child', status: 'running' })).ok).toBe(true);
  });
  it('rejects malformed or fictitious report states at the boundary', () => {
    expect(isMemberObservation({ id: 'report', kind: 'report', round: 1, reportState: 'accepted', text: 'success' })).toBe(false);
    expect(parseCliV1Event(JSON.stringify({ type: 'subagent', kind: 'update', id: 'child', status: 'running', observation: { id: 'bad' } })).ok).toBe(false);
  });
  it('keeps valid restored observations and removes malformed persisted data', () => {
    expect(normalizeMemberObservations({ arbitrary: 'object' })).toBeUndefined();
    const valid = { id: 'read', kind: 'result', round: 1, ok: false, at: 3, completedAt: 4 };
    expect(normalizeMemberObservations([valid, { ...valid, at: 'yesterday' }, { ...valid, kind: 'fake' }])).toEqual([valid]);
  });
});
