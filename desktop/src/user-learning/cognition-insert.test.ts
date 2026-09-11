// cognition-insert.ts：任务内非阻断 Cognition 插入闸门（TRYLO-DUAL-SURFACE-SPEC §3.1/§3.2）。

import { describe, it, expect } from 'vitest';
import type { UserLearningSettings } from './types';
import { inTaskCodeRelevant, inTaskWorkRelevant, shouldInsertInTaskCognition } from './cognition-insert';

function settings(overrides: Partial<UserLearningSettings> = {}): UserLearningSettings {
  return {
    enabled: true,
    defaultMode: 'shadow',
    dimensionMode: {},
    cognitionEnabled: true,
    inference: { mode: 'deterministic', enabled: false, allowExecutionContext: false, maxCallsPerTrace: 0, maxCallsPerHour: 1 },
    teamAccessEnabled: false,
    teamComposerEnabled: false,
    ...overrides,
  };
}

describe('shouldInsertInTaskCognition', () => {
  it('inserts only when ready, enabled, no pending card, and a question exists', () => {
    expect(shouldInsertInTaskCognition({
      settings: settings(),
      preparedStart: 'ready',
      pendingCardOnThisConversation: false,
      question: { id: 'q_verify_scope', dimension: 'verification_audit', trigger: 'high_value_gap', prompt: '?', scopeHint: 'x' },
    })).toBe(true);
  });

  it('never inserts when the send is pending the Impact / blocked', () => {
    expect(shouldInsertInTaskCognition({
      settings: settings(), preparedStart: 'pending_impact',
      pendingCardOnThisConversation: false, question: {} as never,
    })).toBe(false);
    expect(shouldInsertInTaskCognition({
      settings: settings(), preparedStart: 'blocked',
      pendingCardOnThisConversation: false, question: {} as never,
    })).toBe(false);
  });

  it('never inserts a second card onto a conversation that already has one', () => {
    expect(shouldInsertInTaskCognition({
      settings: settings(), preparedStart: 'ready',
      pendingCardOnThisConversation: true, question: {} as never,
    })).toBe(false);
  });

  it('is NOT suppressed by Shadow (evidence-gathering, not injection)', () => {
    expect(shouldInsertInTaskCognition({
      settings: settings({ defaultMode: 'shadow' }), preparedStart: 'ready',
      pendingCardOnThisConversation: false, question: {} as never,
    })).toBe(true);
  });

  it('is suppressed when Cognition is disabled', () => {
    expect(shouldInsertInTaskCognition({
      settings: settings({ cognitionEnabled: false }), preparedStart: 'ready',
      pendingCardOnThisConversation: false, question: {} as never,
    })).toBe(false);
  });
});

describe('inTaskCodeRelevant', () => {
  it('a greeting is never relevant', () => {
    expect(inTaskCodeRelevant('你好')).toBe(false);
    expect(inTaskCodeRelevant('hello')).toBe(false);
    expect(inTaskCodeRelevant('...')).toBe(false);
  });

  it('a persistent/migration change can justify a verify-scope question', () => {
    expect(inTaskCodeRelevant('改一下持久化迁移的表结构')).toBe(true);
    expect(inTaskCodeRelevant('我改了数据库迁移')).toBe(true);
  });

  it('an explicit review/verify request always counts', () => {
    expect(inTaskCodeRelevant('帮我审核这段代码')).toBe(true);
    expect(inTaskCodeRelevant('加个测试验证一下')).toBe(true);
  });

  it('opaque filler is not relevant', () => {
    expect(inTaskCodeRelevant('好')).toBe(false);
    expect(inTaskCodeRelevant('继续')).toBe(false);
  });
});

describe('inTaskWorkRelevant', () => {
  it('a Work deliverable prompt routes to Work relevance', () => {
    expect(inTaskWorkRelevant('帮我做一份周报')).toBe(true);
    expect(inTaskWorkRelevant('这个 PPT 太花了')).toBe(true);
    expect(inTaskWorkRelevant('你自己点一下浏览器')).toBe(true);
  });

  it('plain filler is not Work-relevant', () => {
    expect(inTaskWorkRelevant('你好')).toBe(false);
    expect(inTaskWorkRelevant('继续')).toBe(false);
  });
});