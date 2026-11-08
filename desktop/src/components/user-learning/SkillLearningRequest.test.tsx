import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { createNullLearningPort } from '../../learning/learning-port'
import { SkillLearningRequest } from './SkillLearningRequest'

afterEach(cleanup)
it('submits the selected conversation to the actual learning port and leaves resulting proposals pending', async () => {
  const port = createNullLearningPort(), onStaged = vi.fn()
  port.learnExplicit = vi.fn(async () => ({ ok: true, status: 'staged', pendingIds: ['a', 'b'] }))
  render(<SkillLearningRequest port={port} source={{ workspaceRoot: 'D:/repo', sessionId: 'conversation' }} onStaged={onStaged} />)
  fireEvent.change(screen.getByLabelText('学习要求'), { target: { value: '保留刚才修复依赖冲突的步骤' } })
  fireEvent.click(screen.getByRole('button', { name: '整理为技能提案' }))
  await waitFor(() => expect(onStaged).toHaveBeenCalledOnce())
  expect(port.learnExplicit).toHaveBeenCalledWith({ workspaceRoot: 'D:/repo', sessionId: 'conversation', learnRequest: '保留刚才修复依赖冲突的步骤' })
  expect(screen.getByRole('status').textContent).toContain('2 条待审批提案')
})

it('retains approval access for confirmed proposals after partial cancellation', async () => {
  const port = createNullLearningPort(), onStaged = vi.fn()
  port.learnExplicit = vi.fn(async () => ({ ok: false, status: 'cancelled', reason: 'cancelled', pendingIds: ['a'] }))
  render(<SkillLearningRequest port={port} source={{ workspaceRoot: 'D:/repo', sessionId: 'conversation' }} onStaged={onStaged} />)
  fireEvent.change(screen.getByLabelText('学习要求'), { target: { value: '修订方法' } })
  fireEvent.click(screen.getByRole('button', { name: '整理为技能提案' }))
  await waitFor(() => expect(onStaged).toHaveBeenCalledOnce())
  expect(screen.getByRole('status').textContent).toContain('已有 1 条提案仍可')
})

it.each([
  { status: 'no_learning', reason: 'central_learning_no_new_investment', notice: '无需新增学习投入' },
  { status: 'completed', reason: 'central_skill_already_applied', notice: '技能提案已应用' },
])('shows the terminal central result $reason without sending the user back to pending', async result => {
  const port = createNullLearningPort(), onStaged = vi.fn()
  port.learnExplicit = vi.fn(async () => ({ ok: true, status: result.status, reason: result.reason }))
  render(<SkillLearningRequest port={port} source={{ workspaceRoot: 'D:/repo', sessionId: 'conversation' }} onStaged={onStaged} />)
  fireEvent.change(screen.getByLabelText('学习要求'), { target: { value: '核对这次来源' } })
  fireEvent.click(screen.getByRole('button', { name: '整理为技能提案' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain(result.notice))
  expect(onStaged).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).not.toContain('学习安排')
})
