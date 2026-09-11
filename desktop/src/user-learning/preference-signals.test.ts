// §2.1 信号抽取器测试：每维度 strong/weak/无信号；问候与纯任务陈述 → 空；
// 回顾褒贬跨句不命中（同句约束）。

import { describe, expect, it } from 'vitest';
import { extractPreferenceSignals } from './preference-signals';

function strong(prompt: string, product: 'code' | 'work' = 'code') {
  return extractPreferenceSignals(prompt, product).filter((s) => s.strength === 'strong');
}

describe('extractPreferenceSignals', () => {
  it('verification_audit: correction + dimension same sentence → strong', () => {
    const sigs = strong('以后都不要再检查和独立审核了');
    expect(sigs.some((s) => s.dimension === 'verification_audit' && s.kind === 'correction')).toBe(true);
  });

  it('agent_autonomy: self-carrying signal word → strong even without a dimension word', () => {
    const sigs = strong('别自动做，交给你就好');
    expect(sigs.some((s) => s.dimension === 'agent_autonomy' && s.kind === 'task_override')).toBe(true);
  });

  it('work_artifact: 先出一版 self-carries work_artifact_workflow', () => {
    const sigs = strong('PPT 先出一版再给我看', 'work');
    expect(sigs.some((s) => s.dimension === 'work_artifact_workflow')).toBe(true);
  });

  it('weak (signal only, no dimension) does not return a strong signal', () => {
    expect(strong('不要这么干')).toHaveLength(0);
  });

  it('weak (dimension only, no signal) does not return a strong signal', () => {
    expect(strong('帮我改一下数据库迁移')).toHaveLength(0);
  });

  it('pure task statement → no signal', () => {
    expect(strong('帮我写一个排序函数，和原有接口对齐')).toHaveLength(0);
  });

  it('greeting → empty', () => {
    expect(extractPreferenceSignals('你好', 'code')).toHaveLength(0);
  });

  it('retrospective praise/blame must stay in the SAME sentence', () => {
    // "上次…报告" praise is in sentence 1; the override word "直接做" is in
    // sentence 2 with no dimension word → no strong signal.
    const sigs = extractPreferenceSignals('上次做的报告太慢了。这次直接做。', 'work');
    expect(sigs.filter((s) => s.strength === 'strong')).toHaveLength(0);
  });

  it('retrospective same sentence: (上次)+(不错) → strong collaboration_preference', () => {
    const sigs = strong('上次那份报告不错，就按这样来', 'work');
    expect(sigs.some(
      (s) => s.strength === 'strong' && s.kind === 'collaboration_preference' && s.dimension === 'work_artifact_workflow',
    )).toBe(true);
  });

  it('one dimension yields at most one strong signal (dedup)', () => {
    const sigs = strong('以后都不要再审核也不要再检查了');
    expect(sigs.filter((s) => s.dimension === 'verification_audit')).toHaveLength(1);
  });
});