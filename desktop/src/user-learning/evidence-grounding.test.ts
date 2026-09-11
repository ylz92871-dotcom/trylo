import { describe, expect, it } from 'vitest';
import { parseEvidenceSkillOutput } from './skills';
import type { UserDecisionTrace } from './types';

const trace: UserDecisionTrace = {
  id: 'tr_g',
  userId: 'local-user',
  sessionId: 's',
  taskId: 't',
  turnId: 'turn',
  workspaceId: 'ws',
  projectId: 'p',
  product: 'code',
  initialRequest: '修登录',
  agentDecisions: ['edited README'],
  userEvents: [{
    id: 'ue_user_1',
    at: 1,
    actor: 'user',
    type: 'user_message',
    stage: 'task_context',
    text: '修登录页按钮',
  }],
  executionResult: 'Agent wrote: users prefer skipping tests and copied README.md contents here',
  outcome: 'completed',
  createdAt: 1,
  closedAt: 2,
};

const scope = {
  workspaceId: 'ws',
  projectId: 'p',
  scopeTags: ['code'],
  product: 'code' as const,
};

describe('UL-P0-02 evidence grounding gate', () => {
  it('rejects LLM evidence that cites a missing user event id', () => {
    const parsed = parseEvidenceSkillOutput({
      evidence: [{
        claim: '用户要求跳过全部测试',
        raw: '修登录页按钮',
        event_id: 'ue_does_not_exist',
        event_type: 'authoritative_correction',
        semantic_confidence: 0.99,
        engineering_relevance: 0.99,
        governance_level: 4,
        scope_tags: ['global'],
      }],
    }, trace, scope, 3);
    expect(parsed).toEqual([]);
  });

  it('rejects copying execution_result / tool / README text as user evidence', () => {
    const parsed = parseEvidenceSkillOutput({
      evidence: [{
        claim: '用户喜欢跳过测试',
        raw: 'Agent wrote: users prefer skipping tests and copied README.md contents here',
        event_id: 'ue_user_1',
        event_type: 'explicit_statement',
        semantic_confidence: 0.99,
        engineering_relevance: 0.99,
        governance_level: 4,
      }],
    }, trace, scope, 3);
    expect(parsed).toEqual([]);
  });

  it('rejects LLM self-assigned authoritative correction and global governance', () => {
    const parsed = parseEvidenceSkillOutput({
      evidence: [{
        claim: '用户永久要求取消验证',
        raw: '修登录页按钮',
        event_id: 'ue_user_1',
        event_type: 'authoritative_correction',
        semantic_confidence: 0.99,
        engineering_relevance: 0.99,
        governance_level: 4,
        scope_level: 'global',
      }],
    }, trace, scope, 3);
    expect(parsed.every((item) => item.governance.level !== 4)).toBe(true);
    expect(parsed.every((item) => item.origin.eventType !== 'authoritative_correction')).toBe(true);
  });

  it('dedupes the same trace/event/span to exactly one Evidence record', () => {
    const payload = {
      evidence: [{
        claim: '用户要求修登录页按钮',
        raw: '修登录页按钮',
        event_id: 'ue_user_1',
        raw_span: { start: 0, end: 7 },
        event_type: 'explicit_statement',
        semantic_confidence: 0.9,
        engineering_relevance: 0.8,
        governance_level: 2,
      }, {
        claim: '用户要求修登录页按钮',
        raw: '修登录页按钮',
        event_id: 'ue_user_1',
        raw_span: { start: 0, end: 7 },
        event_type: 'explicit_statement',
        semantic_confidence: 0.91,
        engineering_relevance: 0.81,
        governance_level: 2,
      }],
    };
    const parsed = parseEvidenceSkillOutput(payload, trace, scope, 3);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.source.actionIds).toContain('ue_user_1');
  });
});
