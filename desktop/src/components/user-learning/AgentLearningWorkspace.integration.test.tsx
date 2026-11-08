import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { AgentLearningWorkspace } from './AgentLearningWorkspace'
import { readWorkspace } from '../../agent-learning/workspace-data'
import { savePendingOrigin } from './pending-origin'
import type { LearningPort } from '../../learning/learning-port'
import type { DesktopCollaborationResources } from '../../collaboration-learning/desktop-resources'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import type { SkillPendingReviewRequest } from '../../agent-learning/skill-pending-review'

const io = vi.hoisted(() => ({
  domainList: vi.fn(),
  productions: vi.fn(),
  tools: vi.fn(),
  contract: vi.fn(),
}))
vi.mock('../../agent-learning/client', () => ({
  createAgentLearningClient: () => ({ list: io.domainList }),
}))
vi.mock('../../tool-learning/cli-production', () => ({ loadProductionList: io.productions }))
vi.mock('../../tool-learning/cli-status', () => ({ loadToolLearningStatus: io.tools }))
vi.mock('../../tool-learning/cli-contract', () => ({ readToolContract: io.contract }))
vi.mock('./ToolProductionPanel', () => ({ ToolProductionPanel: () => null }))
vi.mock('./ToolAcquisitionReview', () => ({ ToolAcquisitionReview: () => null }))
vi.mock('./ToolContractReview', () => ({ ToolContractReview: () => null }))

const runtime = { cwd: 'D:/reports', cliPath: 'cli.mjs', process: {} } as ToolLearningRuntime
function port(overrides: Record<string, unknown> = {}): LearningPort {
  return {
    listPending: vi.fn(async () => ({ ok: true, pending: [], count: 0 })),
    memorySnapshot: vi.fn(async () => ({ ok: true, snapshot: { memoryBlock: '', userBlock: '' } })),
    skills: vi.fn(async () => ({ ok: true, skills: [] })),
    pendingDetail: vi.fn(),
    applyPending: vi.fn(),
    discardPending: vi.fn(),
    ...overrides,
  } as unknown as LearningPort
}
const pending = {
  id: 'p-skill',
  subsystem: 'skills',
  action: 'create',
  summary: '新增报表技能',
  origin: 'foreground',
  created_at: 1787994502,
}
const requestedHash = 'sha256:' + 'd'.repeat(64)
const reviewRequest: SkillPendingReviewRequest = {
  schemaVersion: 1,
  kind: 'skill_pending_review_request',
  requestRef: 'request-skill-review',
  scope: runtime.cwd,
  pendingId: pending.id,
  expectedHash: requestedHash,
  name: '报表技能',
  action: 'create',
  reason: '请审阅这份技能提案。',
  status: 'awaiting_user_approval',
  sourceRefs: ['issue:report'],
}
const issue = {
  issueId: 'issue-7',
  title: '交接缺少来源',
  reason: '请确认交接资料已补齐',
  decision: 'focused_learning',
  revision: 7,
  updatedAt: '2026-11-04T10:00:00Z',
  reports: [],
  dependencies: [],
  adjustments: [],
  feedback: [],
}
function resources() {
  const resolve = vi.fn(async () => ({ ok: true }))
  const value = {
    scope: runtime.cwd,
    experts: { query: vi.fn(async () => []), requests: vi.fn(async () => []) },
    issues: { read: vi.fn(async () => ({ issues: [] })), resolve },
  }
  return { value: value as unknown as DesktopCollaborationResources, resolve }
}
beforeEach(() => {
  io.domainList.mockReset().mockResolvedValue([])
  io.productions.mockReset().mockResolvedValue({ ok: true, value: { items: [], workspaceId: 'w' } })
  io.tools.mockReset().mockResolvedValue({ ok: true, status: { jobs: [], workspaceId: 'w' } })
  io.contract.mockReset()
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('connected agent learning ownership', () => {
  it('reads the pending owners once under StrictMode, changes scope, and preserves unread failures', async () => {
    const p = port({
      listPending: vi.fn(async () => ({ ok: true, pending: [pending], count: 1 })),
      skills: vi.fn(async () => ({ ok: true, skills: [{ name: '已安装报表技能' }] })),
    })
    const r = resources()
    vi.mocked(r.value.experts.requests).mockResolvedValue([
      {
        requestId: 'expert-review',
        state: 'awaiting_creation',
        revision: 1,
        instruction: '专家创建许可',
      },
    ] as never)
    vi.mocked(r.value.issues.read).mockResolvedValue({ issues: [issue] } as never)
    io.productions.mockResolvedValue({
      ok: true,
      value: {
        workspaceId: 'w',
        items: [
          {
            versionId: 'tool-pending',
            packageName: 'pending-tool',
            packageVersion: '1',
            description: '工具生产许可',
            lifecycle: 'evaluating',
          },
          {
            versionId: 'tool-unrequested',
            packageName: 'draft',
            packageVersion: '1',
            description: '未请求审阅的工具草稿',
            lifecycle: 'evaluating',
          },
        ],
      },
    })
    io.tools.mockResolvedValue({
      ok: true,
      status: {
        workspaceId: 'w',
        jobs: [
          {
            jobId: 'job-production',
            capability: '工具生产许可',
            state: 'waiting_approval',
            outcomeCode: 'production_candidate_pending_review',
            candidateVersionId: 'tool-pending',
          },
          {
            jobId: 'job-contract',
            capability: '工具约定许可',
            contractProposalId: 'contract-pending',
            state: 'waiting_approval',
          },
          {
            jobId: 'job-acquire',
            capability: '工具获取许可',
            outcomeCode: 'acquisition_approval_required',
            state: 'waiting_approval',
          },
        ],
      },
    })
    io.contract.mockResolvedValue({ approved: false })
    const count = vi.fn()
    const view = render(
      <StrictMode>
        <AgentLearningWorkspace
          section="pending"
          learningPort={p}
          runtime={runtime}
          resources={r.value}
          onPendingCountChange={count}
        />
      </StrictMode>,
    )
    expect(await screen.findByRole('button', { name: pending.summary })).toBeTruthy()
    expect(p.listPending).toHaveBeenCalledTimes(1)
    expect(p.memorySnapshot).not.toHaveBeenCalled()
    expect(p.skills).not.toHaveBeenCalled()
    expect(io.domainList).not.toHaveBeenCalled()
    expect(r.value.experts.query).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '未请求审阅的工具草稿' })).toBeNull()
    for (const title of [
      '专家创建许可',
      '工具生产许可',
      '工具约定许可',
      '工具获取许可',
      issue.title,
    ])
      expect(screen.getByRole('button', { name: title })).toBeTruthy()
    await waitFor(() => expect(count).toHaveBeenLastCalledWith(6))
    fireEvent.click(screen.getByRole('button', { name: issue.title }))
    view.rerender(
      <StrictMode>
        <AgentLearningWorkspace
          section="skill"
          learningPort={p}
          runtime={runtime}
          resources={r.value}
        />
      </StrictMode>,
    )
    expect(await screen.findByRole('button', { name: '已安装报表技能' })).toBeTruthy()
    expect(p.skills).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('记录问题解决结果')).toBeNull()
    expect(io.domainList).toHaveBeenCalledTimes(3)
    expect(r.value.experts.query).toHaveBeenCalledTimes(1)

    io.productions.mockResolvedValue({ ok: true, value: { workspaceId: 'w', items: [] } })
    io.tools.mockResolvedValue({ ok: false, reason: 'stop_unconfirmed' })
    vi.mocked(r.value.experts.requests).mockResolvedValue([])
    vi.mocked(r.value.issues.read).mockResolvedValue({ issues: [] } as never)
    const unread = port({
      listPending: vi.fn(async () => ({
        ok: false,
        pending: [],
        count: 0,
        error: 'admin timed out',
      })),
    })
    view.rerender(
      <StrictMode>
        <AgentLearningWorkspace
          section="pending"
          learningPort={unread}
          runtime={runtime}
          resources={r.value}
          onPendingCountChange={count}
        />
      </StrictMode>,
    )
    expect(await screen.findByText('待审批内容尚未读全，暂时无法确认是否为空。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '全部 未读' })).toBeTruthy()
    expect(screen.getByText('记忆：admin timed out')).toBeTruthy()
    expect(screen.getByText('工具：stop_unconfirmed')).toBeTruthy()
    expect(count).toHaveBeenLastCalledWith(undefined)
    expect(screen.queryByText('当前筛选没有待决定事项。')).toBeNull()
    expect(p.applyPending).not.toHaveBeenCalled()
    vi.mocked(unread.listPending).mockResolvedValue({
      ok: false,
      pending: [pending],
      count: 1,
      error: 'admin timed out',
    })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByRole('button', { name: pending.summary })).toBeTruthy()
    expect(screen.getByRole('button', { name: '全部 1+' })).toBeTruthy()
    expect(count).toHaveBeenLastCalledWith(undefined)
    io.productions.mockResolvedValue({
      ok: true,
      value: { workspaceId: 'w', items: [], truncated: true },
    })
    io.tools.mockResolvedValue({
      ok: true,
      status: {
        workspaceId: 'w',
        truncated: true,
        jobs: [
          {
            jobId: 'missing-candidate',
            state: 'waiting_approval',
            outcomeCode: 'production_candidate_pending_review',
            candidateVersionId: 'outside-window',
          },
        ],
      },
    })
    view.rerender(
      <StrictMode>
        <AgentLearningWorkspace
          section="pending"
          learningPort={p}
          runtime={runtime}
          resources={r.value}
        />
      </StrictMode>,
    )
    expect(
      await screen.findByText('工具：工具目录仅载入最近 50 项，尚不能确认全部待审批内容。'),
    ).toBeTruthy()
    expect(
      screen.getByText('工具：工具处理记录仅载入最近 50 项，尚不能确认全部待审批内容。'),
    ).toBeTruthy()
    expect(
      screen.getByText(
        '工具：有工具候选等待审阅，但本次未读到对应生产版本，请打开工具库查看处理进展。',
      ),
    ).toBeTruthy()
  })
  it('opens the exact requested skill detail without approving or selecting a memory with the same id', async () => {
    const p = port({
      listPending: vi.fn(async () => ({
        ok: true,
        pending: [{ ...pending, subsystem: 'memory' }, pending],
        count: 2,
      })),
      pendingDetail: vi.fn(async () => ({
        ok: true,
        detail: {
          expectedHash: requestedHash,
          item: { after: '# 请求审阅的技能正文' },
        },
      })),
    })
    const props = {
      section: 'pending' as const,
      learningPort: p,
      runtime,
      skillReviewRequest: reviewRequest,
    }
    const view = render(<AgentLearningWorkspace {...props} />)
    expect(await screen.findByText('请求审阅的技能正文')).toBeTruthy()
    expect(p.pendingDetail).toHaveBeenCalledWith({ subsystem: 'skills', id: pending.id })
    expect(p.applyPending).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '批准并写入' }))
    expect(screen.getByRole('button', { name: '确认写入' })).toBeTruthy()
    view.rerender(<AgentLearningWorkspace {...props} skillReviewRequest={{ ...reviewRequest }} />)
    await waitFor(() => expect(p.pendingDetail).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: '确认写入' })).toBeNull()
    expect(p.applyPending).not.toHaveBeenCalled()
  })

  it('blocks a changed requested hash until explicit rereading and applies only that freshly read hash', async () => {
    const freshHash = 'sha256:' + 'e'.repeat(64)
    let settled = false
    const p = port({
      listPending: vi.fn(async () => ({
        ok: true,
        pending: settled ? [] : [pending],
        count: settled ? 0 : 1,
      })),
      pendingDetail: vi.fn(async () => ({
        ok: true,
        detail: {
          expectedHash: freshHash,
          item: { after: '# 当前技能版本' },
        },
      })),
      applyPending: vi.fn(async () => {
        settled = true
        return { ok: true }
      }),
    })
    render(
      <AgentLearningWorkspace
        section="pending"
        learningPort={p}
        runtime={runtime}
        skillReviewRequest={reviewRequest}
      />,
    )
    expect(await screen.findByText('当前技能版本')).toBeTruthy()
    expect(screen.getByRole('button', { name: '批准并写入' })).toHaveProperty('disabled', true)
    expect(p.applyPending).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重新审阅当前版本' }))
    await waitFor(() => expect(p.pendingDetail).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '批准并写入' })).toHaveProperty('disabled', false),
    )
    fireEvent.click(screen.getByRole('button', { name: '批准并写入' }))
    fireEvent.click(screen.getByRole('button', { name: '确认写入' }))
    await waitFor(() =>
      expect(p.applyPending).toHaveBeenCalledWith({
        subsystem: 'skills',
        id: pending.id,
        expectedHash: freshHash,
        reason: 'approved in Trylo desktop',
      }),
    )
  })

  it('rejects review navigation for another scope and reports missing pending without an approval', async () => {
    const p = port({
      pendingDetail: vi.fn(async () => ({
        ok: true,
        detail: {
          expectedHash: requestedHash,
          item: { after: '# 后来出现的技能提案' },
        },
      })),
    })
    const props = { section: 'pending' as const, learningPort: p, runtime }
    const view = render(
      <AgentLearningWorkspace
        {...props}
        skillReviewRequest={{ ...reviewRequest, scope: 'D:/other' }}
      />,
    )
    expect(
      await screen.findByText('此技能审阅请求属于其他工作区，请切换到对应工作区后再打开。'),
    ).toBeTruthy()
    expect(p.pendingDetail).not.toHaveBeenCalled()
    view.rerender(<AgentLearningWorkspace {...props} skillReviewRequest={reviewRequest} />)
    expect(
      await screen.findByText('未在当前待审批队列中找到此技能提案，请刷新后确认其状态。'),
    ).toBeTruthy()
    expect(p.pendingDetail).not.toHaveBeenCalled()
    expect(p.applyPending).not.toHaveBeenCalled()
    vi.mocked(p.listPending).mockResolvedValue({ ok: true, pending: [pending], count: 1 })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('后来出现的技能提案')).toBeTruthy()
    expect(p.applyPending).not.toHaveBeenCalled()
  })

  it('refreshes a mounted queue for a new review and ignores its late detail after the workspace changes', async () => {
    let finishDetail: ((value: unknown) => void) | undefined
    const p = port({
      pendingDetail: vi.fn(
        () =>
          new Promise((resolve) => {
            finishDetail = resolve
          }),
      ),
    })
    const props = { section: 'pending' as const, learningPort: p, runtime }
    const view = render(<AgentLearningWorkspace {...props} />)
    await screen.findByText('待审批内容尚未读全，暂时无法确认是否为空。')
    vi.mocked(p.listPending).mockResolvedValue({ ok: true, pending: [pending], count: 1 })
    view.rerender(<AgentLearningWorkspace {...props} skillReviewRequest={reviewRequest} />)
    await waitFor(() =>
      expect(p.pendingDetail).toHaveBeenCalledWith({ subsystem: 'skills', id: pending.id }),
    )
    expect(p.listPending).toHaveBeenCalledTimes(2)
    view.rerender(
      <AgentLearningWorkspace
        {...props}
        runtime={{ ...runtime, cwd: 'D:/other' }}
        skillReviewRequest={reviewRequest}
      />,
    )
    await screen.findByText('此技能审阅请求属于其他工作区，请切换到对应工作区后再打开。')
    await act(async () => {
      finishDetail?.({
        ok: true,
        detail: {
          expectedHash: requestedHash,
          item: { after: '# 旧工作区迟到的详情' },
        },
      })
    })
    expect(screen.queryByText('旧工作区迟到的详情')).toBeNull()
    expect(screen.queryByRole('button', { name: '批准并写入' })).toBeNull()
    expect(p.applyPending).not.toHaveBeenCalled()
  })

  it('rereads library decisions and selected content on return while preserving the queue filters', async () => {
    const r = resources(),
      p = port(),
      count = vi.fn()
    let saved = false
    vi.mocked(r.value.experts.requests).mockImplementation(
      async () =>
        [
          {
            requestId: 'review-expert',
            state: saved ? 'saved' : 'awaiting_retention',
            revision: saved ? 2 : 1,
            createdAt: '2026-11-04',
            instruction: '账单复核',
            origin: 'task',
            configuration: {
              displayName: '账单复核专家',
              specialty: '复核报表',
              methods: [
                {
                  title: '复核方法',
                  instructions: saved ? '保留零值并逐行核对。' : '先检查字段。',
                },
              ],
            },
          },
        ] as never,
    )
    const props = {
      section: 'pending' as const,
      learningPort: p,
      runtime,
      resources: r.value,
      onPendingCountChange: count,
      refreshKey: 0,
    }
    const view = render(<AgentLearningWorkspace {...props} />)
    await screen.findByRole('button', { name: '账单复核专家' })
    fireEvent.click(screen.getByRole('button', { name: /^专家\s+1$/ }))
    fireEvent.change(screen.getByRole('searchbox', { name: '查找学习内容' }), {
      target: { value: '账单' },
    })
    fireEvent.click(screen.getByRole('button', { name: '账单复核专家' }))
    await screen.findByText('先检查字段。')

    saved = true
    view.rerender(<AgentLearningWorkspace {...{ ...props, refreshKey: 1 }} />)
    await waitFor(() => expect(r.value.experts.requests).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('保留零值并逐行核对。')).toBeTruthy()
    await waitFor(() => expect(count).toHaveBeenLastCalledWith(0))
    expect(screen.getByRole('button', { name: '打开专家库查看与管理' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回待审批' }))
    expect(screen.getByRole('searchbox', { name: '查找学习内容' })).toHaveProperty('value', '账单')
    expect(screen.getByRole('button', { name: /^专家\s+0$/ }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('uses the contract owner decision instead of a stale job outcome when building the queue', async () => {
    const id = 'tool-contract-proposal_v1_' + 'a'.repeat(64)
    io.tools.mockResolvedValue({
      ok: true,
      status: {
        workspaceId: 'w',
        jobs: [
          {
            jobId: 'job-before-resume',
            capability: '字段检查',
            state: 'waiting_approval',
            outcomeCode: 'usage_revision_proposed',
            contractProposalId: id,
          },
        ],
      },
    })
    io.contract.mockResolvedValue({ proposalId: id, approved: true })
    const result = await readWorkspace({ port: port(), runtime }, new AbortController().signal)
    expect(result.items.find((item) => item.kind === 'contract')).toMatchObject({
      id,
      pending: false,
      status: '约定已批准',
    })
  })
  it('aggregates every domain and keeps automatic methods and workflows out of user approvals', async () => {
    const p = port({
      listPending: vi.fn(async () => ({
        ok: true,
        pending: [pending, { ...pending, id: 'p-memory', subsystem: 'memory' }],
        count: 2,
      })),
    })
    io.domainList.mockImplementation(async (domain: string) => [
      {
        id: domain + '-v1',
        versionId: domain + '-v1',
        title: domain,
        summary: '自动结果',
        status: 'trial',
        source: '任务证据',
      },
    ])
    io.productions.mockResolvedValue({
      ok: true,
      value: {
        workspaceId: 'w',
        items: [
          {
            versionId: 'tool-v1',
            packageName: 'report-check',
            packageVersion: '1',
            description: '字段检查',
            lifecycle: 'awaiting_approval',
          },
        ],
      },
    })
    const r = resources()
    vi.mocked(r.value.experts.query).mockResolvedValue([
      {
        expertId: 'reviewer',
        version: 1,
        createdAt: '2026-11-04',
        configuration: { displayName: '复核专家', specialty: '检查字段', sources: [] },
      },
    ] as never)
    vi.mocked(r.value.experts.requests).mockResolvedValue([
      {
        requestId: 'expert-request',
        state: 'awaiting_retention',
        revision: 3,
        createdAt: '2026-11-04',
        instruction: '复核报表',
        origin: 'task',
      },
    ] as never)
    vi.mocked(r.value.issues.read).mockResolvedValue({ issues: [issue] } as never)
    const result = await readWorkspace(
      { port: p, runtime, resources: r.value },
      new AbortController().signal,
    )

    expect([...new Set(result.items.map((i) => i.domain))].sort()).toEqual([
      'collaboration',
      'expert',
      'memory',
      'method',
      'skill',
      'tool',
      'workflow',
    ])
    expect(result.errors).toEqual([])
    expect(
      result.items
        .filter((i) => i.domain === 'method' || i.domain === 'workflow')
        .map((i) => i.pending),
    ).toEqual([false, false])
    expect(
      result.items
        .filter((i) => i.pending)
        .map((i) => i.kind)
        .sort(),
    ).toEqual(['expert-request', 'issue', 'pending', 'pending', 'production'])
    expect(r.resolve).not.toHaveBeenCalled()
  })

  it('uses the inspected detail hash, commits before template copying, and retains a copy-failure notice after refresh', async () => {
    const calls: string[] = [],
      reviewedHash = 'sha256:' + 'b'.repeat(64)
    let settled = false
    const apply = vi.fn(async () => {
      calls.push('apply')
      settled = true
      return { ok: true }
    })
    const copy = vi.fn(async () => {
      calls.push('copy')
      throw new Error('copy transport failed')
    })
    const p = port({
      listPending: vi.fn(async () => ({
        ok: true,
        pending: settled ? [] : [{ ...pending, expectedHash: 'sha256:' + 'a'.repeat(64) }],
        count: settled ? 0 : 1,
      })),
      pendingDetail: vi.fn(async () => ({
        ok: true,
        detail: {
          expectedHash: reviewedHash,
          item: {
            after: '# 完整新技能\n\n保存这份内容。',
            target: 'skills/report-review/SKILL.md',
          },
        },
      })),
      applyPending: apply,
      health: vi.fn(async () => ({ hermesHome: 'D:/hermes' })),
      copyTemplateUnderOut: copy,
    })
    savePendingOrigin(pending.id, {
      origin: 'foreground',
      label: '交付任务',
      skillName: 'report-review',
      sourceRel: '.trylo/out/report.pptx',
      workspaceRoot: runtime.cwd,
      bytes: 40,
      mtimeMs: 12,
      createdAt: 1787994502,
    })
    render(<AgentLearningWorkspace section="pending" learningPort={p} />)
    fireEvent.click(await screen.findByRole('button', { name: pending.summary }))
    fireEvent.click(await screen.findByRole('button', { name: '批准并写入' }))
    fireEvent.click(screen.getByRole('button', { name: '确认写入' }))
    await waitFor(() =>
      expect(vi.mocked(p.listPending).mock.calls.length).toBeGreaterThanOrEqual(2),
    )

    expect(apply).toHaveBeenCalledWith({
      subsystem: 'skills',
      id: pending.id,
      expectedHash: reviewedHash,
      reason: 'approved in Trylo desktop',
    })
    expect(calls).toEqual(['apply', 'copy'])
    expect(copy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRel: '.trylo/out/report.pptx',
        expectedBytes: 40,
        expectedMtimeMs: 12,
      }),
    )
    expect(await screen.findByText('内容已写入，模板副本复制未完成。')).toBeTruthy()
  })

  it('does not expose an approval for truncated content even when a detail hash exists', async () => {
    const apply = vi.fn()
    const p = port({
      listPending: vi.fn(async () => ({ ok: true, pending: [pending], count: 1 })),
      pendingDetail: vi.fn(async () => ({
        ok: true,
        detail: {
          expectedHash: 'sha256:' + 'c'.repeat(64),
          item: { after: '# 不完整技能', complete: false },
        },
      })),
      applyPending: apply,
    })
    render(<AgentLearningWorkspace section="pending" learningPort={p} />)
    fireEvent.click(await screen.findByRole('button', { name: pending.summary }))
    expect(await screen.findByText('详情内容不完整，请重新加载后再批准。')).toBeTruthy()
    const approve = screen.getByRole('button', { name: '批准并写入' })
    expect(approve).toHaveProperty('disabled', true)
    fireEvent.click(approve)
    expect(screen.queryByRole('button', { name: '确认写入' })).toBeNull()
    expect(apply).not.toHaveBeenCalled()
  })

  it('resolves an exact collaboration issue revision without granting authority to its trial artifact', async () => {
    const r = resources()
    vi.mocked(r.value.issues.read).mockResolvedValue({ issues: [issue] } as never)
    render(<AgentLearningWorkspace section="pending" learningPort={port()} resources={r.value} />)
    fireEvent.click(await screen.findByRole('button', { name: issue.title }))
    fireEvent.click(screen.getByRole('button', { name: '记录问题解决结果' }))
    fireEvent.change(screen.getByRole('textbox', { name: '解决说明' }), {
      target: { value: '接收成员已取得来源与单位，可以继续复核。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认已解决' }))
    await waitFor(() => expect(r.resolve).toHaveBeenCalledOnce())
    const [scope, command, signal] = r.resolve.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      AbortSignal,
    ]
    expect(scope).toBe(runtime.cwd)
    expect(command).toEqual({
      schemaVersion: 1,
      action: 'resolve',
      issueId: issue.issueId,
      expectedRevision: 7,
      reason: '接收成员已取得来源与单位，可以继续复核。',
    })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(r.value.experts.requests).toHaveBeenCalled()
    expect(command).not.toHaveProperty('activate')
    expect(command).not.toHaveProperty('approveExperience')
  })
})
