import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProcessService } from '../../host-adapter/process-service'
import type { FilePath } from '../../host-adapter/types'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import { acquisitionFixture, acquisitionTestOwner, failedAcquisitionFixture } from '../../tool-learning/acquisition-test-support'
import { acquisitionInquiryFixture, committedAcquisitionInquiryFixture, strategyAcquisitionInquiryFixture } from '../../tool-learning/acquisition-inquiry-test-support'
import { parseToolAcquisitionInquiryReview } from '../../tool-learning/acquisition-inquiry-contract'
import { ToolAcquisitionReview } from './ToolAcquisitionReview'
import { ToolAcquisitionInquiry } from './ToolAcquisitionInquiry'

afterEach(cleanup)
it('shows a non-acquisition strategy as a complete bounded model hypothesis with no execution action', () => {
  const original = failedAcquisitionFixture(), strategy = strategyAcquisitionInquiryFixture(original), proposal = { ...strategy.outcome!.proposal!,
    rationale: `TEST ONLY ${'保持完整条件。'.repeat(120)} 最终例外必须保留` }
  const decoded = parseToolAcquisitionInquiryReview(JSON.stringify({ ok: true, ...strategy, outcome: { ...strategy.outcome, proposal } }), original)
  expect(decoded.ok).toBe(true); if (!decoded.ok) throw new Error(decoded.reason)
  const review = decoded.value
  const onConfirm = vi.fn()
  render(<ToolAcquisitionInquiry review={review} busy={false} blocked={false} canMutate={false} onReview={() => {}} onConfirm={onConfirm}
    onRecover={() => {}} onOpenProposal={() => {}} />)
  expect(screen.getByText('待审策略（模型假设）')).toBeTruthy()
  expect(screen.getByText(proposal.rationale)).toBeTruthy()
  expect(screen.getByText(/尚未执行或验证/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '查看新待审方案' })).toBeNull()
  expect(screen.queryByRole('button', { name: '使用原额度续查' })).toBeNull()
  expect((screen.getByRole('button', { name: '同步已保存研究结果' }) as HTMLButtonElement).disabled).toBe(true)
  expect(onConfirm).not.toHaveBeenCalled()
})
it('reads the original quota before an explicit inquiry, then opens a separately reviewable decision without approving it', async () => {
  const original = failedAcquisitionFixture(), ready = acquisitionInquiryFixture(original), committed = committedAcquisitionInquiryFixture(original)
  const child = acquisitionFixture({ jobId: committed.outcome!.reviewJobId!, approvalId: committed.outcome!.approvalId!,
    candidate: { ...original.candidate, id: 'TEST_ONLY_replacement', version: '2.0.0' } })
  const calls: string[][] = []; let researched = false
  const runtime: ToolLearningRuntime = { cliPath: 'D:/cli/main.js' as FilePath, cwd: 'D:/workspace' as FilePath, ...acquisitionTestOwner(), process: {
    async spawn(options: Parameters<ProcessService['spawn']>[0]) {
      calls.push([...options.args])
      const inquiry = options.args.includes('--reinvestigate-failure'), mutation = options.args.includes('--confirm-inquiry')
      if (mutation) researched = true
      const value = mutation ? { ok: true } : inquiry ? { ok: true, ...(researched ? committed : ready) }
        : { ok: true, ...(options.args.includes(child.jobId) ? child : original) }
      options.onOutput(JSON.stringify(value)); options.onExit?.({ id: 'TEST_ONLY_review', pid: 1, code: 0, signal: null })
      return { id: 'TEST_ONLY_review', pid: 1, label: options.label, command: options.command }
    }, stop: async () => {},
  } }
  render(<ToolAcquisitionReview runtime={runtime} jobId={original.jobId} workspaceId={original.workspaceId} onClose={() => {}} onOpenProduction={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: '审阅原任务续查' }))
  expect(await screen.findByText(/原额度剩余 2 次模型调用/)).toBeTruthy()
  expect(calls.filter(args => args.includes('--approve'))).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '使用原额度续查' }))
  expect(await screen.findByRole('button', { name: '查看新待审方案' })).toBeTruthy()
  expect(calls.filter(args => args.includes('--approve'))).toHaveLength(1)
  expect(calls.find(args => args.includes('--approve'))).toContain(original.approvalId)
  expect(calls.find(args => args.includes('--approve'))).toContain(ready.reviewId)
  expect(screen.getByRole('button', { name: '同步已保存研究结果' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '查看新待审方案' }))
  expect(await screen.findByText('TEST_ONLY_replacement · 2.0.0')).toBeTruthy()
  expect(await screen.findByRole('button', { name: '授权获取并准备适配' })).toBeTruthy()
  expect(calls.some(args => args.includes('--approve') && args.includes(child.approvalId))).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '返回原获取方案' }))
  await waitFor(() => expect(screen.getByText(/已保存获取依据/)).toBeTruthy())
  expect(calls.filter(args => args.includes('--approve'))).toHaveLength(1)
  expect(calls.flat().some(arg => ['run_shell', '--allow-tools', 'production-activate'].includes(arg))).toBe(false)
})
