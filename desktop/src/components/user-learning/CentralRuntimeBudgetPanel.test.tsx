import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CentralRuntimeBudgetPanel } from './CentralRuntimeBudgetPanel'
import { CentralBudgetCommandError } from '../../agent-learning/central-runtime-budget'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'

const io = vi.hoisted(() => ({ read: vi.fn(), set: vi.fn() }))
vi.mock('../../agent-learning/central-runtime-budget', async original => ({ ...await original<typeof import('../../agent-learning/central-runtime-budget')>(),
  readCentralRuntimeBudget: io.read, setCentralRuntimeBudgetLimits: io.set }))
const runtime = { cwd: 'D:/workspace', cliPath: 'cli.mjs', process: {} } as ToolLearningRuntime
const budget = { rootRef: { budgetId: 'original-root', scope: runtime.cwd, openedSequence: 1, authorizationRef: 'auth' }, boardSequence: 7,
  limits: { tokens: 1000, calls: 5, steps: 5 }, occupied: { tokens: 800, calls: 4, steps: 4 }, available: { tokens: 200, calls: 1, steps: 1 }, status: 'available' }
const value = { enabled: false, budget }
beforeEach(() => { io.read.mockReset().mockResolvedValue(value);io.set.mockReset() })
afterEach(cleanup)
async function editor() {
  render(<CentralRuntimeBudgetPanel runtime={runtime} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '调整累计上限' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: '调整累计上限' }))
}
describe('cumulative budget editor', () => {
  it('makes current totals, reservation occupancy and stopped activation visible before an explicit submit', async () => {
    await editor()
    expect(screen.getByRole('columnheader', { name: '当前累计总额' })).toBeInTheDocument()
    expect(screen.getByText(/已占用包含已发生费用和未结算预留/)).toBeInTheDocument()
    expect(screen.getByText('学习已停用，更新预算不会自动开启。')).toBeInTheDocument()
    expect(io.set).not.toHaveBeenCalled()
  })
  it('keeps the same change identity when an uncertain save is retried, and never enables stopped learning', async () => {
    await editor()
    io.set.mockRejectedValueOnce(new CentralBudgetCommandError('timeout', 'unknown'))
      .mockResolvedValueOnce({ ...value, mutation: 'duplicate', wake: { status: 'skipped' } })
    const field = screen.getByRole('spinbutton', { name: /新的总 token累计上限/ })
    fireEvent.change(field, { target: { value: '2000' } })
    fireEvent.click(screen.getByRole('button', { name: '保存累计上限' }))
    await screen.findByRole('button', { name: '核对并重试同次变更' })
    const first = io.set.mock.calls[0]?.[1]
    fireEvent.click(screen.getByRole('button', { name: '核对并重试同次变更' }))
    await screen.findByText('累计上限已保存；学习仍处于停用状态。')
    expect(io.set.mock.calls[1]?.[1]).toEqual(first)
    expect(first.limits).toEqual({ tokens: 2000, calls: 5, steps: 5 })
  })
  it('does not report an unconfirmed wake as learning continued', async () => {
    io.set.mockResolvedValue({ ...value, enabled: true, wake: { status: 'unconfirmed', reason: 'runtime_unavailable' } })
    await editor();fireEvent.click(screen.getByRole('button', { name: '保存累计上限' }))
    await screen.findByText('累计上限已保存，学习通知尚未确认。可在学习控制中手动继续。')
    expect(screen.queryByText('累计上限已保存，已通知当前学习继续处理。')).not.toBeInTheDocument()
  })
  it('uses the refreshed Board sequence after a confirmed stale rejection', async () => {
    io.set.mockRejectedValueOnce(new CentralBudgetCommandError('learning_budget_stale', 'rejected'))
      .mockResolvedValueOnce({ ...value, mutation: 'applied', wake: { status: 'skipped' } })
    await editor();fireEvent.click(screen.getByRole('button', { name: '保存累计上限' }))
    await screen.findByText('预算在编辑期间发生变化，请刷新后重新核对。')
    io.read.mockResolvedValue({ ...value, budget: { ...budget, boardSequence: 8 } })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await screen.findByRole('button', { name: '保存累计上限' })
    fireEvent.click(screen.getByRole('button', { name: '保存累计上限' }))
    await screen.findByText('累计上限已保存；学习仍处于停用状态。')
    expect(io.set.mock.calls[1]?.[1].expectedSequence).toBe(8)
    expect(io.set.mock.calls[1]?.[1].changeId).not.toBe(io.set.mock.calls[0]?.[1].changeId)
  })
})
