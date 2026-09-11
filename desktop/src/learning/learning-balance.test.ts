import { describe, expect, it } from 'vitest';
import { classifyLearningSignal, planPostTerminal, PROMPT_LAYER_ORDER } from './learning-balance';

describe('learning-balance', () => {
  it('routes collaboration language to the user plane and procedures to Hermes', () => {
    expect(classifyLearningSignal('减少重复审核，核心路径保留最终验证')).toBe('user');
    expect(classifyLearningSignal('下次把这套部署命令做成 skill')).toBe('task');
    expect(classifyLearningSignal('hello')).toBe('neither');
  });

  it('keeps Active Policy above on-demand Hermes layers', () => {
    expect(PROMPT_LAYER_ORDER.indexOf('user_learning_active_policy'))
      .toBeLessThan(PROMPT_LAYER_ORDER.indexOf('hermes_skill_on_demand'));
  });

  it('lets both planes run after a normal completed Code turn', () => {
    const plan = planPostTerminal({
      outcome: 'completed',
      userLearningEnabled: true,
      hermesEnabled: true,
      cognitionTurn: false,
      pendingUserInterrupt: false,
    });
    expect(plan).toEqual({
      closeUserTrace: true,
      enrichUserLearning: true,
      hermesReview: true,
      reasonCode: 'both',
    });
  });

  it('does not start a Hermes skill review during Cognition or a pending Impact card', () => {
    expect(planPostTerminal({
      outcome: 'completed',
      userLearningEnabled: true,
      hermesEnabled: true,
      cognitionTurn: true,
      pendingUserInterrupt: false,
    }).hermesReview).toBe(false);
    expect(planPostTerminal({
      outcome: 'completed',
      userLearningEnabled: true,
      hermesEnabled: true,
      cognitionTurn: false,
      pendingUserInterrupt: true,
    }).reasonCode).toBe('user_only_interrupt');
  });

  it('still closes a User Learning trace on failure, but skips Hermes review', () => {
    const plan = planPostTerminal({
      outcome: 'failed',
      userLearningEnabled: true,
      hermesEnabled: true,
      cognitionTurn: false,
      pendingUserInterrupt: false,
    });
    expect(plan.closeUserTrace).toBe(true);
    expect(plan.hermesReview).toBe(false);
  });
});
