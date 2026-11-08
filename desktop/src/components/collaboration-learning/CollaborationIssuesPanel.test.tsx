import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  CollaborationIssueControlResultV1,
  CollaborationIssuesClient,
  CollaborationIssuesSnapshotV1,
} from '../../collaboration-learning/issues-client'
import { CollaborationIssuesPanel } from './CollaborationIssuesPanel'

afterEach(cleanup)
const scope = 'D:/workspace-a'
const snapshot = (
  workspace = scope,
  title = '交接字段未说明单位',
): CollaborationIssuesSnapshotV1 => ({
  schemaVersion: 1,
  scope: workspace,
  issues: [
    {
      issueId: 'issue-unit',
      revision: 7,
      title,
      decision: 'focused_learning',
      reason: '成员反馈显示需要先澄清交接安排。',
      updatedAt: '2026-11-03T10:00:00Z',
      reports: [
        {
          reportId: 'report-a',
          memberId: 'expert:finance:v2',
          facts: ['交接文件没有单位字段。'],
          suspectedCauses: ['可能是两个成员的单位约定不同。'],
          evidenceRefs: [],
        },
      ],
      learning: {
        jobId: 'job-a',
        state: 'waiting_dependency',
        grantId: 'grant-central-a',
        unit: 'total_model_tokens',
        allowance: 16000,
        spent: 320,
        remaining: 15680,
      },
      dependencies: [
        {
          dependencyId: 'dep-a',
          owner: 'tool',
          requestId: 'tool-request-a',
          state: 'waiting',
          approvalStage: 'creation',
        },
        {
          dependencyId: 'dep-b',
          owner: 'expert',
          requestId: 'expert-request-b',
          state: 'ready',
          approvalStage: 'retention',
        },
        { dependencyId: 'dep-c', owner: 'skill', state: 'pending' },
      ],
      adjustments: [
        {
          adjustmentRef: 'adjust-a',
          title: '补齐交接内容后开工',
          details: '先同步单位与来源，再开始依赖任务。',
          affectedMembers: ['expert:finance:v2'],
          state: 'awaiting_handoff',
          experienceVersionIds: ['experience:finance:3'],
        },
      ],
      feedback: [
        { ref: 'feedback-a', summary: '成员反馈已收到补充字段。', sourceRefs: ['report-b'] },
      ],
    },
  ],
})
const settledClient = (value = snapshot()): CollaborationIssuesClient => ({
  read: vi.fn().mockResolvedValue(value),
  resolve: vi.fn(),
})
function submitResolution(reason = '已补充单位并完成双方确认。') {
  fireEvent.click(screen.getByRole('button', { name: '问题已解决' }))
  const submit = screen.getByRole('button', { name: '确认已解决' })
  expect(submit).toBeDisabled()
  fireEvent.change(screen.getByLabelText('解决说明'), { target: { value: `  ${reason}  ` } })
  fireEvent.click(submit)
}

it('shows owner facts, hypotheses, actual quotas and dependencies without creating approval controls', async () => {
  const client = settledClient(),
    discuss = vi.fn(),
    open = vi.fn()
  render(
    <CollaborationIssuesPanel
      workspaceRoot={scope}
      client={client}
      onDiscuss={discuss}
      onOpenDependency={open}
    />,
  )
  expect(await screen.findByRole('heading', { name: '交接字段未说明单位' })).toBeInTheDocument()
  fireEvent.click(screen.getByText('成员报告（1）'))
  const report = within(screen.getByRole('region', { name: '成员报告 expert:finance:v2' }))
  expect(report.getByRole('heading', { name: '成员观察' }).nextElementSibling).toHaveTextContent(
    '交接文件没有单位字段。',
  )
  expect(report.getByRole('heading', { name: '原因推测' }).nextElementSibling).toHaveTextContent(
    '可能是两个成员的单位约定不同。',
  )
  expect(report.getByText(/尚未补充；不影响报告问题/)).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '中央学习额度' })).toHaveTextContent(
    '额度 16,000 · 已记账 320 · 剩余 15,680',
  )
  const dependencies = screen.getByRole('region', { name: '学习依赖' })
  expect(dependencies).toHaveTextContent('工具 · 等待结果')
  expect(dependencies).toHaveTextContent('创建前审批')
  expect(dependencies).toHaveTextContent('长期入库审批')
  expect(dependencies).not.toHaveTextContent('已同意')
  expect(
    within(dependencies).queryByRole('button', { name: /同意|批准|创建|入库/ }),
  ).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '查看工具原申请' }))
  expect(open).toHaveBeenLastCalledWith('tool', 'tool-request-a')
  fireEvent.click(screen.getByRole('button', { name: '查看专家原申请' }))
  expect(open).toHaveBeenLastCalledWith('expert', 'expert-request-b')
  fireEvent.click(screen.getByRole('button', { name: '与 Personal Agent 讨论' }))
  expect(discuss).toHaveBeenCalledWith('issue-unit')
  expect(screen.getByText(/补齐交接内容后开工/)).toHaveTextContent('等待交接')
  fireEvent.click(screen.getByText(/补齐交接内容后开工/))
  expect(screen.getByText('experience:finance:3')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '实际使用反馈' })).toHaveTextContent(
    '成员反馈已收到补充字段。',
  )
  expect(client.resolve).not.toHaveBeenCalled()
})

it('sends explicit CAS resolution and waits for the refreshed owner state before claiming resolution', async () => {
  const initial = snapshot(),
    resolved = {
      ...initial,
      issues: [{ ...initial.issues[0]!, revision: 8, decision: 'resolved' }],
    }
  let finishRead!: (value: CollaborationIssuesSnapshotV1) => void
  const client = {
    read: vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockImplementationOnce(
        () =>
          new Promise<CollaborationIssuesSnapshotV1>((resolve) => {
            finishRead = resolve
          }),
      ),
    resolve: vi.fn().mockResolvedValue({ schemaVersion: 1, ok: true, revision: 8 }),
  }
  render(<CollaborationIssuesPanel workspaceRoot={scope} client={client} />)
  await screen.findByRole('heading', { name: '交接字段未说明单位' })
  submitResolution()
  await waitFor(() => expect(client.read).toHaveBeenCalledTimes(2))
  expect(client.resolve.mock.calls[0]?.slice(0, 2)).toEqual([
    scope,
    {
      schemaVersion: 1,
      action: 'resolve',
      issueId: 'issue-unit',
      expectedRevision: 7,
      reason: '已补充单位并完成双方确认。',
    },
  ])
  expect(screen.queryByText('已记录解决说明，状态已刷新。')).not.toBeInTheDocument()
  await act(async () => finishRead(resolved))
  expect(await screen.findByText('已记录解决说明，状态已刷新。')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '问题已解决' })).not.toBeInTheDocument()
})

it('keeps conflicts visibly unconfirmed and requires an actual refresh before another mutation', async () => {
  const client = {
    read: vi.fn().mockResolvedValue(snapshot()),
    resolve: vi
      .fn()
      .mockResolvedValue({ schemaVersion: 1, ok: false, reason: 'revision_conflict' }),
  }
  render(<CollaborationIssuesPanel workspaceRoot={scope} client={client} />)
  await screen.findByRole('heading', { name: '交接字段未说明单位' })
  submitResolution()
  expect(await screen.findByRole('alert')).toHaveTextContent('未能确认问题已解决')
  expect(screen.getByRole('button', { name: '问题已解决' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '确认已解决' })).toBeDisabled()
  expect(client.read).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '问题已解决' })).toBeEnabled())
  expect(client.read).toHaveBeenCalledTimes(2)
  expect(client.resolve).toHaveBeenCalledOnce()
})

it('rejects a different workspace projection and recovers from read failures only on request', async () => {
  const client = {
    read: vi
      .fn()
      .mockRejectedValueOnce(new Error('cli_unavailable'))
      .mockResolvedValueOnce(snapshot('D:/foreign', '不应显示的其他工作区'))
      .mockResolvedValue(snapshot()),
    resolve: vi.fn(),
  }
  render(<CollaborationIssuesPanel workspaceRoot={scope} client={client} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法读取协作问题')
  expect(client.read).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('返回状态与当前工作区不一致')
  expect(screen.queryByText('不应显示的其他工作区')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
  expect(await screen.findByRole('heading', { name: '交接字段未说明单位' })).toBeInTheDocument()
  expect(client.resolve).not.toHaveBeenCalled()
})

it('aborts old workspace reads and mutations, ignores late completion and clears the old busy state', async () => {
  let finishOld!: (value: CollaborationIssueControlResultV1) => void
  const old = {
    read: vi.fn((_scope: string, _signal: AbortSignal) => Promise.resolve(snapshot())),
    resolve: vi.fn(
      (_scope: string, _control: unknown, _signal: AbortSignal) =>
        new Promise<CollaborationIssueControlResultV1>((resolve) => {
          finishOld = resolve
        }),
    ),
  }
  const next = settledClient(snapshot('D:/workspace-b', '新的协作问题'))
  const rendered = render(<CollaborationIssuesPanel workspaceRoot={scope} client={old} />)
  await screen.findByRole('heading', { name: '交接字段未说明单位' })
  submitResolution()
  await waitFor(() => expect(old.resolve).toHaveBeenCalledOnce())
  const readSignal = old.read.mock.calls[0]?.[1] as AbortSignal,
    writeSignal = old.resolve.mock.calls[0]?.[2] as AbortSignal
  rendered.rerender(<CollaborationIssuesPanel workspaceRoot="D:/workspace-b" client={next} />)
  expect(await screen.findByRole('heading', { name: '新的协作问题' })).toBeInTheDocument()
  expect(readSignal.aborted).toBe(true)
  expect(writeSignal.aborted).toBe(true)
  expect(screen.getByRole('button', { name: '问题已解决' })).toBeEnabled()
  await act(async () => finishOld({ schemaVersion: 1, ok: true, revision: 8 }))
  expect(old.read).toHaveBeenCalledOnce()
  expect(next.read).toHaveBeenCalledOnce()
  expect(screen.queryByText('已记录解决说明，状态已刷新。')).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '新的协作问题' })).toBeInTheDocument()
})
