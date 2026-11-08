import type { LearningPort } from '../learning/learning-port'
import type { DesktopCollaborationResources } from '../collaboration-learning/desktop-resources'
import { loadToolLearningStatus, type ToolLearningRuntime } from '../tool-learning/cli-status'
import { loadProductionList } from '../tool-learning/cli-production'
import { readToolContract, type ToolContractReview } from '../tool-learning/cli-contract'
import { createAgentLearningClient, type AgentLearningDomain } from './client'
import { normalize, type PendingProposalView } from '../components/user-learning/PendingProposals'
import {
  snapshotDocument,
  type LearningDocument,
} from '../components/user-learning/learning-document'

export type WorkspaceDomain =
  'memory' | 'method' | 'skill' | 'tool' | 'workflow' | 'collaboration' | 'expert'
export type WorkspaceItem = {
  readonly key: string
  readonly id: string
  readonly domain: WorkspaceDomain
  readonly kind:
    | 'pending'
    | 'memory'
    | 'skill'
    | 'learned'
    | 'production'
    | 'acquisition'
    | 'contract'
    | 'expert'
    | 'expert-request'
    | 'issue'
  readonly title: string
  readonly summary: string
  readonly status: string
  readonly source: string
  readonly version: string
  readonly date?: string | number
  readonly pending: boolean
  readonly raw: Record<string, unknown>
  readonly proposal?: PendingProposalView
  readonly document?: LearningDocument
}
export type WorkspaceRead = {
  readonly items: readonly WorkspaceItem[]
  readonly errors: readonly { domain: WorkspaceDomain; message: string }[]
}
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
export const string = (value: unknown): string => (typeof value === 'string' ? value : '')
export const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])
export function dateLabel(value?: string | number): string {
  if (value === undefined || value === '') return ''
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    : String(value)
}
export const domainLabels: Readonly<Record<WorkspaceDomain, string>> = {
  memory: '记忆',
  method: '方法',
  skill: '技能',
  tool: '工具',
  workflow: '工作流',
  collaboration: '协作',
  expert: '专家',
}
export const stateLabel = (value: string): string =>
  (
    ({
      active: '已启用',
      awaiting_approval: '待审阅',
      awaiting_creation: '等待创建许可',
      authorized: '已允许创建',
      awaiting_retention: '等待留存决定',
      revision_requested: '等待修订',
      saved: '已保存',
      temporary: '临时使用',
      rejected: '未获同意',
      trial: '试用经验',
      working: '工作经验',
      stable: '稳定经验',
      resolved: '已解决',
      focused_learning: '聚焦学习',
      unreviewed: '待判断',
      suspended: '已停用',
      dormant: '休眠',
      archived: '已归档',
      active_pool: '工作经验',
      succeeded: '已完成',
      waiting_approval: '待授权',
      waiting_evidence: '等待依据',
      queued: '排队中',
      running: '进行中',
      evicted: '已淘汰',
      path: '流程路径',
      lessons_only: '步骤经验',
      eligible: '可供采用',
      blocked: '有待处理条件',
      unsettled: '待形成结论',
      opportunity: '改进机会',
      proposed: '已提出',
      legacy_trial: '历史试用经验',
      legacy_suspended: '历史经验已停用',
    }) as Record<string, string>
  )[value] ?? value

/** Aggregate owner read models only; no domain lifecycle or approval is inferred here. */
export async function readWorkspace(
  input: {
    readonly port: LearningPort
    readonly runtime?: ToolLearningRuntime
    readonly resources?: DesktopCollaborationResources
    readonly section?: 'pending' | 'all'
  },
  signal: AbortSignal,
): Promise<WorkspaceRead> {
  signal.throwIfAborted()
  const pendingOnly = input.section === 'pending'
  const pendingToolCandidates = new Set<string>()
  const items: WorkspaceItem[] = [],
    errors: { domain: WorkspaceDomain; message: string }[] = []
  const collect = async (domain: WorkspaceDomain, task: () => Promise<void>) => {
    try {
      await task()
    } catch (error) {
      if (!signal.aborted)
        errors.push({ domain, message: error instanceof Error ? error.message : String(error) })
    }
  }
  const tasks: Promise<void>[] = [
    collect('memory', async () => {
      const result = await input.port.listPending()
      if (!result.ok)
        errors.push({ domain: 'memory', message: result.error || '暂时无法读取审批队列' })
      for (const raw of result.pending) {
        const p = normalize(raw)
        if (!p) continue
        items.push({
          key: 'pending:' + p.subsystem + ':' + p.id,
          id: p.id,
          domain: p.subsystem === 'skills' ? 'skill' : 'memory',
          kind: 'pending',
          title: p.summary,
          summary: p.action,
          source: p.origin,
          status: '等待决定',
          version: '待审内容',
          ...(p.createdAt === null ? {} : { date: p.createdAt }),
          pending: true,
          raw,
          proposal: p,
        })
      }
    }),
  ]
  if (!pendingOnly)
    tasks.push(
      collect('memory', async () => {
        const result = await input.port.memorySnapshot()
        if (!result.ok) throw new Error(result.error || '暂时无法读取记忆')
        const snapshot = object(result.snapshot ?? result)
        for (const [target, title] of [
          ['memory', '长期记忆'],
          ['user', '用户画像'],
        ] as const) {
          const body = string(
            snapshot[target === 'memory' ? 'memoryBlock' : 'userBlock'] ?? snapshot[target],
          )
          if (!body.trim()) continue
          items.push({
            key: 'memory:' + target,
            id: target,
            domain: 'memory',
            kind: 'memory',
            title,
            summary: body.replace(/\s+/g, ' ').slice(0, 120),
            status: '当前保存内容',
            source: '记忆文件',
            version: '当前快照',
            pending: false,
            raw: { target },
            document: snapshotDocument(body, target),
          })
        }
      }),
      collect('skill', async () => {
        const result = await input.port.skills({ op: 'list' })
        if (!result.ok) throw new Error(result.error || '暂时无法读取技能')
        for (const raw of list(result.skills)) {
          const r = object(raw),
            name = string(r.name ?? r.title ?? r.id)
          if (!name) continue
          items.push({
            key: 'skill:' + name,
            id: name,
            domain: 'skill',
            kind: 'skill',
            title: name,
            summary: string(r.description ?? r.summary),
            status: '已安装',
            source: string(r.category) || '技能文件',
            version: string(r.version) || '当前安装内容',
            pending: false,
            raw: r,
          })
        }
      }),
    )
  if (input.runtime) {
    const client = createAgentLearningClient(input.runtime)
    for (const domain of pendingOnly ? [] : (['method', 'workflow', 'collaboration'] as const))
      tasks.push(
        collect(domain, async () => {
          const entries = await client.list(domain as AgentLearningDomain, signal)
          for (const entry of entries)
            items.push({
              key: domain + ':' + entry.id,
              id: entry.id,
              domain,
              kind: 'learned',
              title: entry.title,
              summary: entry.summary,
              status: stateLabel(entry.status),
              source: entry.source,
              version: entry.versionId,
              ...(entry.createdAt === undefined ? {} : { date: entry.createdAt }),
              pending: false,
              raw: entry as unknown as Record<string, unknown>,
            })
        }),
      )
    tasks.push(
      collect('tool', async () => {
        const result = await loadProductionList(input.runtime!, signal)
        if (!result.ok) throw new Error(result.reason)
        if (result.value.truncated)
          errors.push({
            domain: 'tool',
            message: '工具目录仅载入最近 50 项，尚不能确认全部待审批内容。',
          })
        for (const r of result.value.items)
          items.push({
            key: 'production:' + r.versionId,
            id: r.versionId,
            domain: 'tool',
            kind: 'production',
            title: r.description || r.packageName,
            summary: r.packageName,
            status: stateLabel(r.lifecycle),
            source: r.packageName,
            version: r.packageVersion,
            pending: r.lifecycle === 'awaiting_approval',
            raw: { ...r, workspaceId: result.value.workspaceId },
          })
      }),
    )
    tasks.push(
      collect('tool', async () => {
        const result = await loadToolLearningStatus({ ...input.runtime!, signal })
        if (!result.ok) throw new Error(result.reason)
        if (result.status.truncated)
          errors.push({
            domain: 'tool',
            message: '工具处理记录仅载入最近 50 项，尚不能确认全部待审批内容。',
          })
        const contractReviews = new Map<string, ToolContractReview>()
        const proposalIds = [
          ...new Set(
            result.status.jobs.flatMap((job) =>
              job.contractProposalId ? [job.contractProposalId] : [],
            ),
          ),
        ]
        for (let start = 0; start < proposalIds.length; start += 4) {
          await Promise.allSettled(
            proposalIds.slice(start, start + 4).map(async (id) => {
              try {
                contractReviews.set(id, await readToolContract(input.runtime!, id, signal))
              } catch (error) {
                if (!signal.aborted)
                  errors.push({ domain: 'tool', message: '调用约定状态未读到：' + String(error) })
              }
            }),
          )
        }
        for (const r of result.status.jobs) {
          if (
            r.state === 'waiting_approval' &&
            r.candidateVersionId &&
            [
              'npm_candidate_pending_review',
              'candidate_pending_review',
              'production_candidate_pending_review',
            ].includes(r.outcomeCode ?? '')
          )
            pendingToolCandidates.add(r.candidateVersionId)
          if (r.contractProposalId)
            items.push({
              key: 'contract:' + r.contractProposalId,
              id: r.contractProposalId,
              domain: 'tool',
              kind: 'contract',
              title: r.capability,
              summary: '调用约定修订',
              status: contractReviews.get(r.contractProposalId)?.approved
                ? '约定已批准'
                : '待审阅修订',
              source: r.jobId,
              version: r.contractProposalId,
              date: r.createdAt,
              pending: contractReviews.has(r.contractProposalId)
                ? !contractReviews.get(r.contractProposalId)!.approved
                : r.state === 'waiting_approval' || r.outcomeCode === 'usage_revision_proposed',
              raw: { ...r },
            })
          if (r.outcomeCode === 'acquisition_approval_required' || r.acquisition)
            items.push({
              key: 'acquisition:' + r.jobId,
              id: r.jobId,
              domain: 'tool',
              kind: 'acquisition',
              title: r.capability,
              summary: r.acquisition?.failure
                ? `已保存获取阻碍：${r.acquisition.failure.code}`
                : '工具获取与适配',
              status: r.acquisition?.failure
                ? r.acquisition.failure.recovery === 'await_stop'
                  ? '获取停止待确认'
                  : '获取遇到阻碍'
                : stateLabel(r.state),
              source: r.jobId,
              version: r.candidateVersionId || '',
              date: r.createdAt,
              pending: r.outcomeCode === 'acquisition_approval_required',
              raw: { ...r, workspaceId: result.status.workspaceId },
            })
        }
      }),
    )
  } else
    for (const domain of pendingOnly
      ? (['tool'] as const)
      : (['method', 'tool', 'workflow', 'collaboration'] as const))
      errors.push({ domain, message: '当前工作区尚未连接 CLI' })
  if (input.resources) {
    const resources = input.resources
    if (!pendingOnly)
      tasks.push(
        collect('expert', async () => {
          for (const expert of await resources.experts.query('', signal)) {
            const c = expert.configuration
            items.push({
              key: 'expert:' + expert.expertId + ':' + expert.version,
              id: expert.expertId,
              domain: 'expert',
              kind: 'expert',
              title: c.displayName,
              summary: c.specialty,
              status: '已保存',
              source: c.sources.map((s) => s.title).join('、') || '专家配置',
              version: 'v' + expert.version,
              date: expert.createdAt,
              pending: false,
              raw: expert as unknown as Record<string, unknown>,
            })
          }
        }),
      )
    tasks.push(
      collect('expert', async () => {
        for (const r of await resources.experts.requests(signal))
          items.push({
            key: 'expert-request:' + r.requestId,
            id: r.requestId,
            domain: 'expert',
            kind: 'expert-request',
            title: r.configuration?.displayName || r.instruction,
            summary: r.instruction,
            status: stateLabel(r.state),
            source: r.origin,
            version: '申请 r' + r.revision,
            date: r.createdAt,
            pending: ['awaiting_creation', 'awaiting_retention', 'revision_requested'].includes(
              r.state,
            ),
            raw: r as unknown as Record<string, unknown>,
          })
      }),
    )
    tasks.push(
      collect('collaboration', async () => {
        const snap = await resources.issues.read(resources.scope, signal)
        for (const r of snap.issues)
          items.push({
            key: 'issue:' + r.issueId,
            id: r.issueId,
            domain: 'collaboration',
            kind: 'issue',
            title: r.title,
            summary: r.reason || '',
            status: stateLabel(r.decision),
            source: r.reports.map((p) => p.memberId).join(' → '),
            version: '问题 r' + r.revision,
            date: r.updatedAt,
            pending: r.decision !== 'resolved',
            raw: r as unknown as Record<string, unknown>,
          })
      }),
    )
  } else {
    errors.push({ domain: 'expert', message: '当前工作区尚未连接专家库' })
    if (pendingOnly)
      errors.push({ domain: 'collaboration', message: '当前工作区尚未连接协作问题记录' })
  }
  await Promise.allSettled(tasks)
  signal.throwIfAborted()
  for (const versionId of pendingToolCandidates) {
    const index = items.findIndex((item) => item.kind === 'production' && item.id === versionId)
    const item = items[index]
    if (!item) {
      errors.push({
        domain: 'tool',
        message: '有工具候选等待审阅，但本次未读到对应生产版本，请打开工具库查看处理进展。',
      })
    } else if (['evaluating', 'shadow', 'awaiting_approval'].includes(string(item.raw.lifecycle))) {
      items[index] = { ...item, pending: true, status: '等待验证与审阅' }
    }
  }
  const seen = new Set<string>()
  return {
    items: items.filter((item) => {
      if (seen.has(item.key)) return false
      seen.add(item.key)
      return true
    }),
    errors,
  }
}
