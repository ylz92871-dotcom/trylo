import { describe, expect, it } from 'vitest'
import { parseCentralLearningStatus } from './central-status'

describe('canonical central budget read contract', () => {
  const base = { schemaVersion: 1, domain: 'central', scope: 'D:/repo', issues: [], stages: [] }
  it('distinguishes an unopened pool from a fabricated zero balance', () => {
    expect(parseCentralLearningStatus(JSON.stringify({ ...base, budget: null })).budget).toBeNull()
    expect(() => parseCentralLearningStatus(JSON.stringify({ ...base }))).toThrow('central_status_invalid_reply')
  })
  it('retains honest negative availability and rejects inconsistent balance projections', () => {
    const budget = { budgetId: 'root:one', limits: { tokens: 100, calls: 2, steps: 2 },
      occupied: { tokens: 120, calls: 1, steps: 1 }, available: { tokens: -20, calls: 1, steps: 1 },
      status: 'held', holdReason: 'model_cap_violated' }
    expect(parseCentralLearningStatus(JSON.stringify({ ...base, budget })).budget?.available.tokens).toBe(-20)
    expect(() => parseCentralLearningStatus(JSON.stringify({ ...base, budget: { ...budget,
      available: { tokens: 0, calls: 1, steps: 1 } } }))).toThrow('central_status_invalid_reply')
  })
  it('does not reinterpret an unknown stage outcome as learning success', () => {
    const stage = { unitId: 'unit:one', stageRef: 'stage:one', criterion: 'proposal_delivered', outcome: 'qualified', sourceRef: 'source:one', sequence: 5 }
    expect(parseCentralLearningStatus(JSON.stringify({ ...base, budget: null, stages: [stage] })).stages[0]?.outcome).toBe('qualified')
    expect(() => parseCentralLearningStatus(JSON.stringify({ ...base, budget: null, stages: [{ ...stage, outcome: 'completed' }] })))
      .toThrow('central_status_invalid_reply')
  })
})
