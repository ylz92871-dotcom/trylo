// Team evidence provenance tests (PR-9, spec §13 / §20.8).

import { describe, expect, it } from 'vitest';
import { extractEvidenceFromTrace } from '../evidence';
import {
  teamEvidenceProvenance,
  teamProvenanceOf,
  withTeamProvenance,
} from './evidence-map';
import type { EvidenceScope, UserDecisionEvent, UserDecisionTrace } from '../types';

function scope(): EvidenceScope {
  return { workspaceId: 'ws', projectId: 'p', scopeTags: ['code'] };
}

function trace(events: readonly UserDecisionEvent[]): UserDecisionTrace {
  return {
    id: 'tr_1',
    userId: 'local-user',
    sessionId: 's1',
    taskId: 't1',
    turnId: 'turn1',
    workspaceId: 'ws',
    projectId: 'p',
    product: 'code',
    initialRequest: '实现导出模块',
    agentDecisions: [],
    userEvents: events,
    createdAt: 1,
  };
}

const PROVENANCE = teamEvidenceProvenance({
  seatId: 'worker',
  teamRunId: 'team-conv-1',
  contractId: 'ec_1',
  contractVersion: 2,
});

describe('teamEvidenceProvenance', () => {
  it('always carries source user and never flips to seat actor', () => {
    expect(PROVENANCE.source).toBe('user');
    expect(PROVENANCE.seatId).toBe('worker');
    expect(PROVENANCE.agentPolicyCaused).toBe(false);
  });
});

describe('withTeamProvenance', () => {
  it('merges into structured without disturbing other keys', () => {
    const event = withTeamProvenance(
      { at: 1, actor: 'user' as const, type: 'stop' as const, stage: 'post_execution' as const, text: 'user stopped the run', structured: { other: 1 } },
      PROVENANCE,
    );
    expect(event.structured?.['other']).toBe(1);
    expect(teamProvenanceOf(event)?.teamRunId).toBe('team-conv-1');
  });

  it('returns the event unchanged without provenance', () => {
    const event = { at: 1, actor: 'user' as const, type: 'stop' as const, stage: 'post_execution' as const, text: 'x' };
    expect(withTeamProvenance(event, undefined)).toBe(event);
  });
});

describe('extraction (spec §20.8: agent veto/PASS 不成 Evidence；user stop 成 Evidence)', () => {
  it('agent-only verdicts (PASS / veto) produce no evidence', () => {
    const agentEvents: UserDecisionEvent[] = [
      { id: 'a1', at: 1, actor: 'agent', type: 'agent_decision', stage: 'post_execution', text: 'VERDICT: PASS' },
      { id: 'a2', at: 2, actor: 'agent', type: 'agent_decision', stage: 'post_execution', text: 'Person 否决：与 explicit 冲突' },
    ];
    expect(extractEvidenceFromTrace(trace(agentEvents), scope(), 10)).toEqual([]);
  });

  it('a user stop with team provenance is evidence (silence ≠ approval untouched)', () => {
    const stop = withTeamProvenance(
      { at: 3, actor: 'user' as const, type: 'stop' as const, stage: 'post_execution' as const, text: 'user stopped the run' },
      PROVENANCE,
    ) as UserDecisionEvent;
    const out = extractEvidenceFromTrace(trace([stop]), scope(), 10);
    expect(out.length).toBe(1);
    expect(out[0]!.origin.eventType).toBe('intervention');
    expect((out[0]!.rawObservation.structured as Record<string, unknown>)['teamProvenance']).toBeTruthy();
  });

  it('team provenance marks agentPolicyCaused without changing event type', () => {
    const steer = withTeamProvenance(
      { at: 4, actor: 'user' as const, type: 'steer' as const, stage: 'post_execution' as const, text: '按 explicit 走' },
      teamEvidenceProvenance({ teamRunId: 'team-conv-1', contractId: 'ec_1', contractVersion: 1, agentPolicyCaused: true }),
    ) as UserDecisionEvent;
    const out = extractEvidenceFromTrace(trace([steer]), scope(), 10);
    expect(out.length).toBe(1);
    expect(teamProvenanceOf(out[0]!.rawObservation as { structured?: Readonly<Record<string, unknown>> })?.agentPolicyCaused).toBe(true);
  });
});
