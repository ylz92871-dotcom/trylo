import { describe, expect, it } from 'vitest'
import { agentLearningForRun, agentLearningSettings } from './agent-learning'

describe('agent learning task settings', () => {
  it('keeps the agent domains independent of User Learning and checking', () => {
    expect(agentLearningForRun(undefined, false)).toEqual({})
    expect(agentLearningForRun({ enabled: true }, false)).toEqual({
      learning: 'agent',
      skillLearningAllowance: { maxTokens: 32000, maxCalls: 4 },
    })
    expect(agentLearningForRun({ enabled: true }, true).learning).toBe('all')
    expect(agentLearningForRun(undefined, true)).toEqual({ learning: 'user' })
  })
  it('respects collection/retention and validates the independently allocated skill budget', () => {
    expect(
      agentLearningForRun({ enabled: true }, true, {
        collectNewLearning: false,
        retention: 'normal',
      }),
    ).toEqual({})
    expect(
      agentLearningForRun({ enabled: true }, true, {
        collectNewLearning: true,
        retention: 'session_only',
      }),
    ).toEqual({})
    expect(agentLearningSettings({ enabled: true, skillTokens: -1, skillCalls: 100 })).toEqual({
      enabled: true,
      skillTokens: 32000,
      skillCalls: 4,
      skillOutputTokens: 8000,
      centralEnabled: false,
      centralTokens: 160000,
      centralCalls: 16,
      centralThoughtMaxTokens: 64000,
    })
    expect(
      agentLearningForRun({ enabled: true, skillTokens: 64000, skillCalls: 8 }, false)
        .skillLearningAllowance,
    ).toEqual({ maxTokens: 64000, maxCalls: 8 })
  })
  it('uses one persistent workspace authorization without enabling User Learning or another skill purse', () => {
    const value = { enabled: true, centralEnabled: true, centralTokens: 128000, centralCalls: 16 }
    expect(agentLearningForRun(value, false)).toEqual({
      learning: 'agent',
      centralLearningAllowance: { maxTokens: 128000, maxCalls: 16 },
    })
    expect(Object.hasOwn(agentLearningSettings(value), 'centralThoughtMaxTokens')).toBe(false)
    expect(
      Object.hasOwn(
        agentLearningForRun(value, false).centralLearningAllowance!,
        'thoughtMaxTokens',
      ),
    ).toBe(false)
    expect(agentLearningForRun(value, true).learning).toBe('all')
    expect(
      agentLearningForRun(value, true, { collectNewLearning: false, retention: 'normal' }),
    ).toEqual({})
    expect(
      agentLearningForRun(value, true, { collectNewLearning: true, retention: 'session_only' }),
    ).toEqual({})
    const invalid = agentLearningSettings({
      centralEnabled: true,
      centralTokens: 0,
      centralCalls: 65,
    })
    expect(invalid.centralTokens).toBe(32000)
    expect(invalid.centralCalls).toBe(4)
    expect(invalid.centralEnabled).toBe(false)
    expect(agentLearningForRun({ centralEnabled: true }, false)).toEqual({})
    expect(agentLearningSettings({ enabled: true }).centralEnabled).toBe(false)
  })
  it('offers new central defaults only when raw settings have no stored central cap', () => {
    expect(agentLearningSettings(undefined)).toEqual({
      enabled: false,
      skillTokens: 32000,
      skillCalls: 4,
      skillOutputTokens: 8000,
      centralEnabled: false,
      centralTokens: 160000,
      centralCalls: 16,
      centralThoughtMaxTokens: 64000,
    })
    expect(agentLearningForRun({ centralEnabled: true }, false)).toEqual({})
    expect(agentLearningSettings({ centralTokens: 128000 })).toEqual({
      enabled: false,
      skillTokens: 32000,
      skillCalls: 4,
      skillOutputTokens: 8000,
      centralEnabled: false,
      centralTokens: 128000,
      centralCalls: 4,
    })
    expect(agentLearningSettings({ centralCalls: 12 })).toEqual({
      enabled: false,
      skillTokens: 32000,
      skillCalls: 4,
      skillOutputTokens: 8000,
      centralEnabled: false,
      centralTokens: 32000,
      centralCalls: 12,
    })
    expect(agentLearningSettings({ centralThoughtMaxTokens: 64000 })).toEqual({
      enabled: false,
      skillTokens: 32000,
      skillCalls: 4,
      skillOutputTokens: 8000,
      centralEnabled: false,
      centralTokens: 32000,
      centralCalls: 4,
      centralThoughtMaxTokens: 64000,
    })
  })
  it('carries an explicit thought cap independently and rejects invalid thought authority', () => {
    const value = {
      centralEnabled: true,
      centralTokens: 160000,
      centralCalls: 16,
      centralThoughtMaxTokens: 64000,
    }
    expect(agentLearningForRun(value, false)).toEqual({
      learning: 'agent',
      centralLearningAllowance: { maxTokens: 160000, maxCalls: 16, thoughtMaxTokens: 64000 },
    })
    for (const thought of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1000000001,
      null,
      '64000',
    ]) {
      const invalid = { ...value, centralThoughtMaxTokens: thought }
      expect(agentLearningSettings(invalid)).toMatchObject({
        centralEnabled: false,
        centralTokens: 160000,
        centralCalls: 16,
      })
      expect(Object.hasOwn(agentLearningSettings(invalid), 'centralThoughtMaxTokens')).toBe(false)
      expect(agentLearningForRun(invalid, false)).toEqual({})
    }
  })
})
