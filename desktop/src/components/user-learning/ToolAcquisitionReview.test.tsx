import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FilePath } from '../../host-adapter/types'
import type { ProcessService } from '../../host-adapter/process-service'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import type { ToolAcquisitionReview as Review } from '../../tool-learning/cli-acquisition'
import { acquisitionCandidateVersion, acquisitionContinuationJob, acquisitionFixture, acquisitionInstallation, acquisitionTestOwner, preparedAcquisitionFixture, failedAcquisitionFixture } from '../../tool-learning/acquisition-test-support'
import { ToolAcquisitionReview } from './ToolAcquisitionReview'

afterEach(cleanup)
function harness(initial = acquisitionFixture()) {
  let review = initial, action: Parameters<ProcessService['spawn']>[0] | undefined
  const calls: string[][] = [], stop = vi.fn(async () => {}), owner = acquisitionTestOwner()
  const send = vi.fn(async (id: string) => { if (id === 'action') action?.onExit?.({ id: 'action', pid: 1, code: null, signal: null }) })
  const runtime: ToolLearningRuntime = { cliPath: 'D:/cli/main.js' as FilePath, cwd: 'D:/workspace' as FilePath, ...owner, process: {
    async spawn(options) {
      calls.push([...options.args])
      if (options.args.includes('--approve')) action = options
      else { options.onOutput(JSON.stringify({ ok: true, ...review })); options.onExit?.({ id: 'review', pid: 1, code: 0, signal: null }) }
      return { id: options.args.includes('--approve') ? 'action' : 'review', pid: 1, label: options.label, command: options.command }
    }, stop, send,
  } }
  return { runtime, calls, stop, send, owner, setReview: (next: Review) => { review = next },
    finish: () => { review = preparedAcquisitionFixture(); action?.onOutput(JSON.stringify({ ok: true, versionId: acquisitionCandidateVersion })); action?.onExit?.({ id: 'action', pid: 1, code: 0, signal: null }) } }
}
function show(fx: ReturnType<typeof harness>, onOpenProduction = vi.fn()) {
  const origin = acquisitionFixture()
  return { view: render(<ToolAcquisitionReview runtime={fx.runtime} jobId={origin.jobId} workspaceId={origin.workspaceId} onClose={() => {}} onOpenProduction={onOpenProduction} />), onOpenProduction }
}
it('restores a recorded unsupported acquisition after remount without presenting another active approval', async () => {
  const fx = harness(failedAcquisitionFixture()), first = show(fx)
  expect(await screen.findByText(/已保存获取依据/)).toBeTruthy()
  expect((screen.getByRole('button', { name: '获取阻碍需要先处理' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/可先审阅原任务续查/)).toBeTruthy()
  first.view.unmount(); show(fx)
  expect(await screen.findByText(/已保存获取依据/)).toBeTruthy()
  expect(screen.getByText(/不会自动重试、补充额度或改写原决定/)).toBeTruthy()
  expect(fx.calls.some(args => args.includes('--approve'))).toBe(false)
})
it('offers an explicit transient retry but gives completed installation and continuation precedence over old failure facts', async () => {
  const fx = harness(failedAcquisitionFixture('retry_explicitly')); show(fx)
  expect(await screen.findByRole('button', { name: '按原方案显式重试获取' })).toBeTruthy()
  expect(fx.calls.some(args => args.includes('--approve'))).toBe(false)
  fx.setReview({ ...failedAcquisitionFixture(), installation: acquisitionInstallation, continuation: { jobId: acquisitionContinuationJob, state: 'waiting_evidence', attempt: 1 } })
  fireEvent.click(screen.getByRole('button', { name: '刷新获取进度' }))
  expect(await screen.findByRole('button', { name: '继续准备适配' })).toBeTruthy()
  expect(screen.queryByText(/已保存获取依据/)).toBeNull()
  expect(fx.calls.some(args => args.includes('--approve'))).toBe(false)
})
it('shows the actual selection and planning costs before one explicit authorization, then links the saved candidate', async () => {
  const fx = harness(), opened = show(fx)
  await screen.findByText('@trylo/example · 1.2.3')
  expect(screen.getByText(acquisitionFixture().constructionCost)).toBeTruthy()
  expect(screen.getByText(/以上收益和成本是本次规划的判断/)).toBeTruthy()
  expect(fx.calls.filter(args => args.includes('--approve'))).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '授权获取并准备适配' }))
  expect(await screen.findByText(/正在执行本次授权/)).toBeTruthy()
  expect(fx.calls.filter(args => args.includes('--approve'))).toHaveLength(1)
  expect(screen.queryByRole('button', { name: '授权获取并准备适配' })).toBeNull()
  fx.finish()
  await screen.findByText(/CLI 已确认候选已保存/)
  expect(await screen.findByText(/隔离获取已完成，清单包含 3 个包/)).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: '查看工具管理' }))
  expect(opened.onOpenProduction).toHaveBeenCalledTimes(1)
  expect(fx.calls.flat().some(arg => ['run_shell', 'production-activate', 'production-verify'].includes(arg))).toBe(false)
})
it('cancels waiting, refreshes persisted progress and refuses to retry an unknown running model call', async () => {
  const fx = harness()
  show(fx)
  fireEvent.click(await screen.findByRole('button', { name: '授权获取并准备适配' }))
  fx.setReview(acquisitionFixture({ installation: acquisitionInstallation, continuation: { jobId: acquisitionContinuationJob, state: 'running', attempt: 1 } }))
  fireEvent.click(screen.getByRole('button', { name: '停止等待并确认进度' }))
  expect(await screen.findByText(/操作结果尚未确认/)).toBeTruthy()
  expect(await screen.findByText(/适配仍在处理，或中断结果尚未确认/)).toBeTruthy()
  await waitFor(() => expect(fx.send).toHaveBeenCalledWith('action', expect.stringContaining('interrupt')))
  expect((screen.getByRole('button', { name: '继续准备适配' }) as HTMLButtonElement).disabled).toBe(true)
  expect(fx.calls.filter(args => args.includes('--approve'))).toHaveLength(1)
  expect(fx.calls.filter(args => !args.includes('--approve')).length).toBeGreaterThan(1)
})
it('distinguishes a frozen plan from installation and offers explicit result sync for a committed candidate', async () => {
  const fx = harness(acquisitionFixture({ installation: { ...acquisitionInstallation, installed: false } }))
  show(fx)
  expect(await screen.findByText(/尚未确认隔离获取完成/)).toBeTruthy()
  const prepared = preparedAcquisitionFixture()
  fx.setReview({ ...prepared, continuation: { jobId: acquisitionContinuationJob, state: 'running', attempt: 1, versionId: acquisitionCandidateVersion, recovery: 'committed_candidate' } })
  fireEvent.click(screen.getByRole('button', { name: '刷新获取进度' }))
  expect(await screen.findByText('候选已保存，等待同步处理结果。 · 第 1 次处理')).toBeTruthy()
  expect(fx.calls.filter(args => args.includes('--approve'))).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '同步已保存候选' }))
  expect(fx.calls.filter(args => args.includes('--approve'))).toHaveLength(1)
  expect(fx.calls.find(args => args.includes('--approve'))).toContain('--resume-child')
  expect(fx.calls.find(args => args.includes('--approve'))).toContain(acquisitionContinuationJob)
})
it('rejects a foreign workspace review and aborts its owned pending mutation on unmount', async () => {
  const foreign = harness(acquisitionFixture({ workspaceId: 'workspace:other' })), rejected = show(foreign)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '授权获取并准备适配' })).toBeNull()
  rejected.view.unmount()
  const fx = harness(), mounted = show(fx)
  fireEvent.click(await screen.findByRole('button', { name: '授权获取并准备适配' }))
  mounted.view.unmount()
  await waitFor(() => expect(fx.send).toHaveBeenCalledWith('action', expect.stringContaining('interrupt')))
  expect(fx.calls.filter(args => args.includes('--approve'))).toHaveLength(1)
})
it('retains an unconfirmed pre-child process across view remounts and waits for actual exit before a new approval', async () => {
  const fx = harness()
  fx.owner.lifecycle.acquired?.({ id: 'previous', pid: 1, label: 'TEST ONLY prior acquisition', command: 'node' }, async () => {})
  fx.owner.lifecycle.stopUnconfirmed?.('previous', 'TEST ONLY no exit receipt')
  const first = show(fx)
  expect((await screen.findByRole('button', { name: '授权获取并准备适配' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/当前工作区仍有进程尚未确认停止/)).toBeTruthy()
  first.view.unmount()
  show(fx)
  expect((await screen.findByRole('button', { name: '授权获取并准备适配' }) as HTMLButtonElement).disabled).toBe(true)
  expect(fx.calls.some(args => args.includes('--approve'))).toBe(false)
  act(() => { fx.owner.lifecycle.exited?.('previous') })
  await waitFor(() => expect((screen.getByRole('button', { name: '授权获取并准备适配' }) as HTMLButtonElement).disabled).toBe(false))
  expect(fx.calls.some(args => args.includes('--approve'))).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '授权获取并准备适配' }))
  expect(fx.calls.filter(args => args.includes('--approve'))).toHaveLength(1)
})
