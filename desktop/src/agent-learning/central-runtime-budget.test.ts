import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CentralBudgetCommandError, parseCentralRuntimeBudget, readCentralRuntimeBudget, setCentralRuntimeBudgetLimits } from './central-runtime-budget'
import type { ToolLearningRuntime } from '../tool-learning/cli-status'

const io = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../host-adapter/cli-command', () => ({ runCliCommand: io.run }))
const runtime = { cwd: 'D:/workspace', cliPath: 'cli.mjs', process: {} } as ToolLearningRuntime
const rootRef = { budgetId: 'original-root', scope: runtime.cwd, openedSequence: 1, authorizationRef: 'original-authorization' }
const budget = { rootRef, boardSequence: 7, limits: { tokens: 1000, calls: 5, steps: 5 },
  occupied: { tokens: 800, calls: 4, steps: 4 }, available: { tokens: 200, calls: 1, steps: 1 }, status: 'available' }
const reply = { schemaVersion: 1, domain: 'central_runtime_budget', ok: true, enabled: false, budget }
beforeEach(() => io.run.mockReset())

describe('explicit cumulative central budget client', () => {
  it('reads the real root without creating a task or changing activation', async () => {
    io.run.mockResolvedValue({ ok: true, stdout: JSON.stringify(reply) })
    expect((await readCentralRuntimeBudget(runtime)).budget?.occupied.tokens).toBe(800)
    expect(io.run.mock.calls[0]?.[0].args).toEqual(['learn', 'central', 'runtime', '-'])
    expect(JSON.parse(io.run.mock.calls[0]?.[0].stdin)).toEqual({ workspaceRoot: runtime.cwd, action: 'budget_inspect' })
  })
  it('submits absolute limits and the exact root/change/CAS identity, with no model funding capability', async () => {
    const change = { rootRef, expectedSequence: 7, changeId: 'human-change-1', limits: { tokens: 2000, calls: 8, steps: 8 } }
    io.run.mockResolvedValue({ ok: true, stdout: JSON.stringify({ ...reply, mutation: 'applied', budget: { ...budget, limits: change.limits }, wake: { status: 'skipped' } }) })
    await setCentralRuntimeBudgetLimits(runtime, change)
    expect(JSON.parse(io.run.mock.calls[0]?.[0].stdin)).toEqual({ workspaceRoot: runtime.cwd, action: 'budget_set_limits', ...change })
  })
  it('retains explicit rejection and uncertain transport as different outcomes', async () => {
    io.run.mockResolvedValue({ ok: false, reason: 'exit_2', stdout: JSON.stringify({ schemaVersion: 1, domain: 'central_runtime_budget', ok: false, reason: 'learning_budget_stale' }) })
    await expect(readCentralRuntimeBudget(runtime)).rejects.toMatchObject({ outcome: 'rejected', reason: 'learning_budget_stale' })
    io.run.mockResolvedValue({ ok: false, reason: 'timeout' })
    await expect(setCentralRuntimeBudgetLimits(runtime, { rootRef, expectedSequence: 7, changeId: 'same-on-retry', limits: budget.limits })).rejects.toMatchObject({ outcome: 'unknown' })
    io.run.mockResolvedValue({ ok: false, reason: 'exit_2', stdout: JSON.stringify({ schemaVersion: 2, domain: 'central_runtime_budget', ok: false, reason: 'learning_budget_stale' }) })
    await expect(readCentralRuntimeBudget(runtime)).rejects.toMatchObject({ outcome: 'unknown' })
    expect(() => parseCentralRuntimeBudget(JSON.stringify({ schemaVersion: 1, domain: 'central_runtime_budget', ok: false,
      reason: 'central_runtime_budget_readback_unconfirmed' }))).toThrow(CentralBudgetCommandError)
    try { parseCentralRuntimeBudget(JSON.stringify({ schemaVersion: 1, domain: 'central_runtime_budget', ok: false,
      reason: 'central_runtime_budget_readback_unconfirmed' })) } catch (error) { expect(error).toMatchObject({ outcome: 'unknown' }) }
  })
  it('shows a held overrun as a negative available amount instead of clamping it to zero', () => {
    const parsed = parseCentralRuntimeBudget(JSON.stringify({ ...reply, budget: { ...budget, status: 'held',
      occupied: { ...budget.occupied, tokens: 1100 }, available: { ...budget.available, tokens: -100 } } }))
    expect(parsed.budget?.available.tokens).toBe(-100)
  })
  it('rejects a reply from a different root and malformed counters', async () => {
    io.run.mockResolvedValue({ ok: true, stdout: JSON.stringify({ ...reply, mutation: 'applied', budget: { ...budget, rootRef: { ...rootRef, budgetId: 'other-root' } } }) })
    await expect(setCentralRuntimeBudgetLimits(runtime, { rootRef, expectedSequence: 7, changeId: 'human', limits: budget.limits })).rejects.toBeInstanceOf(CentralBudgetCommandError)
    expect(() => parseCentralRuntimeBudget(JSON.stringify({ ...reply, budget: { ...budget, occupied: { tokens: -1, calls: 0, steps: 0 } } }))).toThrow('central_budget_reply_invalid')
  })
})
