import { describe, expect, it } from 'vitest';
import { evidence } from './hardening-fixtures';
import { classifyPersonalizationEligibility } from './personalization-eligibility';

const classify = (text: string, signalKind: 'collaboration_preference' | 'correction' = 'collaboration_preference') => (
  classifyPersonalizationEligibility({
    evidence: evidence({
      id: 'ev',
      rawObservation: { text },
      inference: { claim: text, semanticConfidence: 0.9, engineeringRelevance: 0.9 },
      signalKind,
    }),
    now: 10,
  }).classification
);

describe('personalization eligibility gate', () => {
  it.each([
    ['涉及账号登录必须先问我', 'authorization_or_permission'],
    ['不要编造引用，来源必须真实', 'safety_or_integrity_requirement'],
    ['这次先给完整草稿', 'session_instruction'],
    ['以后周报先说结论，再展开依据', 'personalization_candidate'],
    ['这个项目的方案先给结构再写完整文稿', 'personalization_candidate'],
  ])('classifies %s', (text, expected) => {
    expect(classify(text)).toBe(expected);
  });

  it('abstains when an actionable preference is not grounded', () => {
    expect(classify('感觉不太对')).toBe('insufficient_information');
  });

  it('keeps an unscoped correction as a quality defect', () => {
    expect(classify('你理解错了，改成正确的数据', 'correction')).toBe('general_quality_defect');
  });
});
