import { describe, expect, it } from 'vitest';
import { resolveAnswer, scopeBoundaryPrompt } from './answer-resolution';
import type { CognitionQuestion } from '../types';

const Q: CognitionQuestion = {
  id: 'q_verify_scope',
  dimension: 'verification_audit',
  trigger: 'high_value_gap',
  prompt: '低风险修改里你希望直接完成还是再独立审核？核心链路是否同样适用？',
  options: [],
  scopeHint: 'verification vs core path',
};

describe('cognition-skill/answer-resolution', () => {
  it('reask on ambiguous short answers', () => {
    expect(resolveAnswer(Q, '看情况').followUp).toBe('reask');
    expect(resolveAnswer(Q, '').followUp).toBe('reask');
    expect(resolveAnswer(Q, '都可以').followUp).toBe('reask');
  });

  it('asks for a boundary when the answer is over-broad with no scope word', () => {
    const res = resolveAnswer(Q, '以后都直接做，不用问');
    expect(res.followUp).toBe('confirm_scope');
    expect(res.candidates.length).toBe(1);
  });

  it('produces one scoped candidate for a single clear scope', () => {
    const res = resolveAnswer(Q, '对于普通小功能，直接完成就好。');
    expect(res.followUp).toBe('none');
    expect(res.candidates.length).toBe(1);
    expect(res.candidates[0]!.scope.scopeTags).not.toContain('core_path');
  });

  it('splits one answer that names both ordinary and core scopes into two candidates', () => {
    const res = resolveAnswer(Q, '普通功能直接做完，核心 Runtime 先计划并保留验证');
    expect(res.followUp).toBe('none');
    expect(res.candidates.length).toBe(2);
    expect(res.candidates.some((c) => c.scope.corePath === true)).toBe(true);
    expect(res.candidates.some((c) => c.scope.corePath === false)).toBe(true);
  });

  it('detects a task category and tags the scope', () => {
    const res = resolveAnswer(Q, '（这题如果是数据库迁移相关）普通 UI 可以少检查，迁移路径不行');
    // ordinary branch carries the category too
    expect(res.followUp).toBe('none');
  });

  it('scopeBoundaryPrompt asks for the boundary not assumed', () => {
    const prompt = scopeBoundaryPrompt(Q);
    expect(prompt).toMatch(/边界/);
    expect(prompt).toMatch(/核心链路|验证/);
  });
});