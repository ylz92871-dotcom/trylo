import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowLeft, ArrowUpRight, FileText, RefreshCw, Search } from 'lucide-react'
import type { LearningPort } from '../../learning/learning-port'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import type { DesktopCollaborationResources } from '../../collaboration-learning/desktop-resources'
import {
  readWorkspace,
  dateLabel,
  domainLabels,
  object,
  string,
  list,
  type WorkspaceDomain,
  type WorkspaceItem,
  type WorkspaceRead,
} from '../../agent-learning/workspace-data'
import { createAgentLearningClient, type AgentLearningDomain } from '../../agent-learning/client'
import {
  sameLearningScope,
  type SkillPendingReviewRequest,
} from '../../agent-learning/skill-pending-review'
import { runCliCommand } from '../../host-adapter/cli-command'
import { extractHash, copyAfterApply } from './PendingProposals'
import { getPendingOrigin, savePendingOrigin, extractSkillNameFromTarget } from './pending-origin'
import { LearningDocumentReader, LearningMarkdown } from './LearningDocumentReader'
import { proposalDocument, type LearningDocument } from './learning-document'
import { ToolProductionPanel } from './ToolProductionPanel'
import { ToolAcquisitionReview } from './ToolAcquisitionReview'
import { ToolContractReview } from './ToolContractReview'
import { AgentDomainContent } from './AgentDomainContent'
import {
  CollaborationIssueDetails,
  ResolveCollaborationIssue,
} from '../collaboration-learning/CollaborationIssueDetails'
import type { CollaborationIssueViewV1 } from '../../collaboration-learning/issues-client'
import './agent-learning-workspace.css'
import { SkillLearningRequest, type SkillLearningSource } from './SkillLearningRequest'
import { CentralLearningStatus } from './CentralLearningStatus'
import { CentralRuntimeBudgetPanel } from './CentralRuntimeBudgetPanel'

export type AgentLearningSection =
  'pending' | 'approved' | 'method' | 'skill' | 'tool' | 'workflow' | 'collaboration' | 'schedule'
export interface AgentLearningWorkspaceProps {
  readonly section: AgentLearningSection
  readonly learningPort: LearningPort
  readonly runtime?: ToolLearningRuntime
  readonly resources?: DesktopCollaborationResources
  readonly refreshKey?: number
  readonly skillLearningSource?: SkillLearningSource
  readonly skillReviewRequest?: SkillPendingReviewRequest
  readonly onPendingCountChange?: (count: number | undefined) => void
  readonly onOpenLibrary?: (owner: 'tool' | 'expert', requestId?: string) => void
}
type ReadDetail = {
  readonly key: string
  readonly document: LearningDocument
  readonly hash?: string
  readonly reviewedRequestRef?: string
}
type Receipt = {
  readonly item: WorkspaceItem
  readonly document: LearningDocument
  readonly at: number
  readonly action: string
}
const headings: Record<AgentLearningSection, string> = {
  pending: '待审批',
  approved: '学习成果与批准记录',
  method: '方法学习',
  skill: '技能学习',
  tool: '工具学习',
  workflow: '工作流学习',
  collaboration: '协作学习',
  schedule: '学习安排',
}
const descriptions: Record<AgentLearningSection, string> = {
  pending: '集中查看需要你决定的改动与待处理事项。',
  approved: '找回保存的内容，核对具体对象与版本。',
  method: '形成的做法、适用条件与采用依据。',
  skill: '查看实际安装的技能文件与待审修订。',
  tool: '从具体需求追到工具产物与版本。',
  workflow: '步骤之间的交付关系，以及实际采用的记录。',
  collaboration: '从发生的问题读到交接约定与采用依据。',
  schedule: '当前工作区中需要继续处理的学习任务。',
}
const versionLabel = (value: string) =>
  value.length > 44 ? value.slice(0, 20) + '…' + value.slice(-8) : value
function jsonDocument(name: string, value: unknown, content?: string): LearningDocument {
  const raw = JSON.stringify(value, null, 2)
  return { name, content: content ?? '```json\n' + raw + '\n```', source: raw, metadata: raw }
}
function expertMarkdown(raw: Record<string, unknown>): string {
  const c = object(raw.configuration)
  let md =
    '# ' +
    (string(c.displayName) || '专家申请') +
    '\n\n' +
    (string(c.specialty) || string(raw.instruction))
  for (const [key, label] of [
    ['situations', '适合的任务'],
    ['responsibilities', '职责'],
    ['constraints', '约束'],
    ['collaboration', '协作方式'],
    ['toolRefs', '使用工具'],
  ] as const) {
    const values = list(c[key])
    if (values.length)
      md += '\n\n## ' + label + '\n\n' + values.map((v) => '- ' + String(v)).join('\n')
  }
  for (const method of list(c.methods)) {
    const m = object(method)
    md += '\n\n## ' + string(m.title) + '\n\n' + string(m.instructions)
  }
  const sources = list(c.sources)
  if (sources.length)
    md +=
      '\n\n## 来源\n\n' +
      sources
        .map((s) => {
          const r = object(s)
          return '- ' + string(r.title) + ' — ' + string(r.uri) + '\n\n' + string(r.excerpt)
        })
        .join('\n')
  return md
}

/** Agent-only UI. Reads and actions are delegated to the existing domain owners. */
export function AgentLearningWorkspace(props: AgentLearningWorkspaceProps): ReactElement {
  const [data, setData] = useState<WorkspaceRead>({ items: [], errors: [] }),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0)
  const [filter, setFilter] = useState<WorkspaceDomain | 'all'>('all'),
    [search, setSearch] = useState(''),
    [selectedKey, setSelectedKey] = useState<string>(),
    [tab, setTab] = useState<'all' | 'receipts'>('all')
  const [detail, setDetail] = useState<ReadDetail>(),
    [detailError, setDetailError] = useState(''),
    [reading, setReading] = useState(false),
    [reader, setReader] = useState(false),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [manage, setManage] = useState(false),
    [resolving, setResolving] = useState(false)
  const [receipts, setReceipts] = useState<readonly Receipt[]>([])
  const lifetime = useRef<AbortController>(),
    detailLifetime = useRef<AbortController>(),
    activeSection = useRef(props.section)
  const lastRefreshKey = useRef(props.refreshKey),
    revalidateSelected = useRef(false)
  const readSection = props.section === 'pending' ? 'pending' : 'all'
  const readInput = useMemo<Parameters<typeof readWorkspace>[0]>(
    () => ({
      port: props.learningPort,
      section: readSection,
      ...(props.runtime ? { runtime: props.runtime } : {}),
      ...(props.resources ? { resources: props.resources } : {}),
    }),
    [props.learningPort, props.runtime, props.resources, readSection],
  )
  const loadedInput = useRef<typeof readInput>(),
    focusedRequest = useRef<SkillPendingReviewRequest>()
  useEffect(() => {
    loadedInput.current = undefined
    focusedRequest.current = undefined
    detailLifetime.current?.abort()
    revalidateSelected.current = false
    setData({ items: [], errors: [] })
    setSelectedKey(undefined)
    setDetail(undefined)
    setConfirm(false)
    setReader(false)
    setReceipts([])
    setNotice('')
    return () => detailLifetime.current?.abort()
  }, [readInput])
  useEffect(() => {
    loadedInput.current = undefined
    focusedRequest.current = undefined
    revalidateSelected.current = false
    detailLifetime.current?.abort()
    setSelectedKey(undefined)
    setDetail(undefined)
    setDetailError('')
    setReading(false)
    setReader(false)
    setConfirm(false)
    setNotice('')
  }, [props.skillReviewRequest])
  useEffect(() => {
    if (lastRefreshKey.current === props.refreshKey) return
    lastRefreshKey.current = props.refreshKey
    revalidateSelected.current = true
    detailLifetime.current?.abort()
    setDetail(undefined)
    setDetailError('')
    setReading(false)
    setReader(false)
    setConfirm(false)
    setManage(false)
    setResolving(false)
  }, [props.refreshKey])
  useEffect(() => {
    const c = new AbortController()
    lifetime.current?.abort()
    lifetime.current = c
    setLoading(true)
    // StrictMode may dispose the first setup before this microtask runs.
    // A discarded setup must not spawn processes merely to cancel them.
    void Promise.resolve()
      .then(() => {
        c.signal.throwIfAborted()
        return readWorkspace(readInput, c.signal)
      })
      .then(
        (result) => {
          if (!c.signal.aborted) {
            loadedInput.current = readInput
            setData(result)
            setLoading(false)
          }
        },
        (e) => {
          if (!c.signal.aborted) {
            loadedInput.current = readInput
            setData({ items: [], errors: [{ domain: 'memory', message: String(e) }] })
            setLoading(false)
          }
        },
      )
    return () => c.abort()
  }, [readInput, refresh, props.refreshKey, props.skillReviewRequest])
  const { onPendingCountChange } = props
  useEffect(() => {
    onPendingCountChange?.(
      loading || loadedInput.current !== readInput || data.errors.length
        ? undefined
        : data.items.filter((i) => i.pending).length,
    )
  }, [data, loading, readInput, onPendingCountChange])
  useEffect(() => {
    if (activeSection.current !== props.section) {
      detailLifetime.current?.abort()
      setSelectedKey(undefined)
      setDetail(undefined)
      setReader(false)
      setManage(false)
      setConfirm(false)
      setResolving(false)
      setSearch('')
      setFilter('all')
      activeSection.current = props.section
    }
  }, [props.section])
  const refreshAll = () => {
    loadedInput.current = undefined
    focusedRequest.current = undefined
    revalidateSelected.current = true
    detailLifetime.current?.abort()
    setDetail(undefined)
    setManage(false)
    setRefresh((v) => v + 1)
  }
  const base =
    props.section === 'pending'
      ? data.items.filter((i) => i.pending)
      : props.section === 'approved'
        ? data.items
        : props.section === 'schedule'
          ? data.items.filter((i) => i.pending || i.status === '进行中' || i.status === '排队中')
          : data.items.filter((i) => i.domain === props.section)
  const rows = base.filter(
    (i) =>
      (filter === 'all' || i.domain === filter) &&
      `${i.title} ${i.summary} ${i.source}`.toLowerCase().includes(search.toLowerCase()),
  )
  const countLabel = (domain?: WorkspaceDomain): string => {
    if (loading || loadedInput.current !== readInput) return '…'
    const count = domain ? base.filter((item) => item.domain === domain).length : base.length
    const unread = data.errors.some(
      (error) =>
        domain === undefined ||
        error.domain === domain ||
        (domain === 'skill' && error.domain === 'memory'),
    )
    return unread ? (count ? `${count}+` : '未读') : String(count)
  }
  const selected = data.items.find((i) => i.key === selectedKey)
  const select = useCallback(
    async (item: WorkspaceItem, reviewedRequestRef?: string) => {
      detailLifetime.current?.abort()
      const c = new AbortController()
      detailLifetime.current = c
      setSelectedKey(item.key)
      setDetail(undefined)
      setDetailError('')
      setReading(true)
      setManage(false)
      setConfirm(false)
      setResolving(false)
      try {
        let document: LearningDocument, hash: string | undefined
        if (item.document) document = item.document
        else if (item.kind === 'pending' && item.proposal) {
          const result = await props.learningPort.pendingDetail({
            subsystem: item.proposal.subsystem,
            id: item.id,
          })
          if (c.signal.aborted) return
          if (!result.ok) throw new Error(result.error || '读取失败')
          const raw = object(result.detail)
          document = proposalDocument(raw, item.proposal.subsystem)
          hash = extractHash(raw) ?? undefined
          const skillName = extractSkillNameFromTarget(raw.target ?? raw.item ?? raw.payload)
          savePendingOrigin(item.id, {
            ...getPendingOrigin(item.id),
            origin: item.proposal.origin,
            label: getPendingOrigin(item.id)?.label ?? item.source,
            ...(skillName ? { skillName } : {}),
            createdAt: item.proposal.createdAt ?? Date.now(),
          })
        } else if (item.kind === 'skill') {
          const result = await props.learningPort.skills({ op: 'view', name: item.id })
          if (!result.ok) throw new Error(result.error || '技能读取失败')
          const content = string(result.content)
          document = content
            ? {
                name: 'SKILL.md',
                content,
                source: content,
                metadata: JSON.stringify(result, null, 2),
              }
            : jsonDocument('SKILL.md', result)
        } else if (item.kind === 'learned' && props.runtime) {
          const cached = object(item.raw)
          if (typeof cached.markdown === 'string' && typeof cached.raw === 'string')
            document = {
              name: item.title + '.md',
              content: cached.markdown,
              source: cached.raw,
              metadata: JSON.stringify(cached, null, 2),
            }
          else {
            const d = await createAgentLearningClient(props.runtime).detail(
              item.domain as AgentLearningDomain,
              item.id,
              c.signal,
            )
            document = {
              name: d.title + '.md',
              content: d.markdown,
              source: d.raw,
              metadata: JSON.stringify(d, null, 2),
            }
          }
        } else if (item.kind === 'production' && props.runtime) {
          const result = await runCliCommand({
            ...props.runtime,
            args: ['tools', 'production-show', item.id, '--json'],
            signal: c.signal,
          })
          if (!result.ok) throw new Error(result.reason)
          const raw: unknown = JSON.parse(result.stdout)
          if (object(raw).ok !== true)
            throw new Error(string(object(raw).message) || '工具版本读取失败')
          const view = object(object(raw).desktopView),
            mastery = object(view.mastery)
          let md = '# ' + item.title + '\n\n' + string(view.capability)
          for (const [key, title] of [
            ['whenToUse', '适用场景'],
            ['preconditions', '输入条件'],
            ['pitfalls', '使用注意'],
          ] as const) {
            const values = list(mastery[key])
            if (values.length)
              md += '\n\n## ' + title + '\n\n' + values.map((v) => '- ' + String(v)).join('\n')
          }
          document = jsonDocument(item.title + '.json', raw, md)
        } else if (item.domain === 'expert')
          document = jsonDocument(item.title + '.json', item.raw, expertMarkdown(item.raw))
        else document = jsonDocument(item.title + '.json', item.raw)
        if (!c.signal.aborted)
          setDetail({
            key: item.key,
            document,
            ...(hash ? { hash } : {}),
            ...(reviewedRequestRef ? { reviewedRequestRef } : {}),
          })
      } catch (e) {
        if (!c.signal.aborted) setDetailError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!c.signal.aborted) setReading(false)
      }
    },
    [props.learningPort, props.runtime],
  )
  const workspaceScope = props.runtime?.cwd ?? props.resources?.scope
  useEffect(() => {
    const request = props.skillReviewRequest
    if (!request || focusedRequest.current === request) return
    if (!sameLearningScope(request.scope, workspaceScope)) {
      focusedRequest.current = request
      setNotice('此技能审阅请求属于其他工作区，请切换到对应工作区后再打开。')
      return
    }
    if (loading || loadedInput.current !== readInput) return
    focusedRequest.current = request
    revalidateSelected.current = false
    setNotice('')
    setSearch('')
    setFilter('all')
    const item = data.items.find(
      (candidate) =>
        candidate.kind === 'pending' &&
        candidate.proposal?.subsystem === 'skills' &&
        candidate.id === request.pendingId,
    )
    if (item) void select(item)
    else setNotice('未在当前待审批队列中找到此技能提案，请刷新后确认其状态。')
  }, [data, loading, props.skillReviewRequest, workspaceScope, readInput, select])
  useEffect(() => {
    if (loading || !revalidateSelected.current) return
    revalidateSelected.current = false
    const fresh = data.items.find((item) => item.key === selectedKey)
    if (fresh) void select(fresh)
    else setSelectedKey(undefined)
  }, [data, loading, selectedKey, select])
  const requestedReview =
    props.skillReviewRequest &&
    selected?.proposal?.subsystem === 'skills' &&
    selected.id === props.skillReviewRequest.pendingId &&
    sameLearningScope(props.skillReviewRequest.scope, workspaceScope)
      ? props.skillReviewRequest
      : undefined
  const changedRequestedVersion =
    !!requestedReview &&
    !!detail &&
    detail.hash !== requestedReview.expectedHash &&
    detail.reviewedRequestRef !== requestedReview.requestRef
  async function applyPending() {
    if (
      !selected?.proposal ||
      detail?.key !== selected.key ||
      !detail.hash ||
      detail.document.approvalIssue ||
      changedRequestedVersion ||
      busy
    )
      return
    const item = selected,
      review = detail
    setBusy(true)
    setNotice('')
    try {
      const result = await props.learningPort.applyPending({
        subsystem: item.proposal!.subsystem,
        id: item.id,
        expectedHash: review.hash!,
        reason: 'approved in Trylo desktop',
      })
      if (!result.ok) throw new Error(result.error || '写入未确认')
      const copy = await copyAfterApply(props.learningPort, item.proposal!)
      let verification
      try {
        verification = await props.learningPort.listPending()
      } catch {
        setNotice('后端已接受写入，暂时无法复核队列，请刷新确认。')
        setConfirm(false)
        return
      }
      if (!verification.ok) {
        setNotice('后端已接受写入，队列复核暂未完成，请刷新确认。')
        setConfirm(false)
        return
      }
      if (
        verification.pending.some(
          (raw) => raw.id === item.id && raw.subsystem === item.proposal!.subsystem,
        )
      ) {
        setNotice('后端仍返回这条提案，请重新读取当前状态后确认。')
        setConfirm(false)
        return
      }
      setReceipts((v) => [
        { item, document: structuredClone(review.document), at: Date.now(), action: '批准写入' },
        ...v,
      ])
      setConfirm(false)
      setNotice(
        copy === 'error'
          ? '内容已写入，模板副本复制未完成。'
          : '内容已写入，正在重新读取保存结果。',
      )
      setSelectedKey(undefined)
      setRefresh((v) => v + 1)
    } catch (e) {
      setNotice('写入未完成：' + String(e))
    } finally {
      setBusy(false)
    }
  }
  async function discard() {
    if (!selected?.proposal || busy) return
    setBusy(true)
    try {
      const result = await props.learningPort.discardPending({
        subsystem: selected.proposal.subsystem,
        id: selected.id,
      })
      if (!result.ok) throw new Error(result.error || '处理未确认')
      setSelectedKey(undefined)
      setRefresh((v) => v + 1)
    } catch (e) {
      setNotice(String(e))
    } finally {
      setBusy(false)
    }
  }
  async function resolve(reason: string) {
    if (!selected || selected.kind !== 'issue' || !props.resources || busy) return
    const issue = selected.raw as unknown as CollaborationIssueViewV1
    setBusy(true)
    try {
      const result = await props.resources.issues.resolve(
        props.resources.scope,
        {
          schemaVersion: 1,
          action: 'resolve',
          issueId: issue.issueId,
          expectedRevision: issue.revision,
          reason,
        },
        new AbortController().signal,
      )
      if (!result.ok) throw new Error(result.reason)
      setResolving(false)
      setSelectedKey(undefined)
      setRefresh((v) => v + 1)
    } catch (e) {
      setNotice('问题状态未更新：' + String(e))
    } finally {
      setBusy(false)
    }
  }
  const currentDetail = selected && detail?.key === selected.key ? detail : undefined
  const module =
    props.section !== 'pending' && props.section !== 'approved' && props.section !== 'schedule'
  return (
    <section
      className={'agent-workspace agent-workspace--' + props.section}
      aria-label={headings[props.section]}
      aria-busy={loading || busy}
    >
      <header className="agent-workspace__header">
        <div>
          <h2>{headings[props.section]}</h2>
          <p>{descriptions[props.section]}</p>
        </div>
        <div className="agent-workspace__actions">
          {props.section === 'tool' ? (
            <button type="button" onClick={() => props.onOpenLibrary?.('tool')}>
              打开工具库 <ArrowUpRight size={13} />
            </button>
          ) : props.section === 'collaboration' ? (
            <button type="button" onClick={() => props.onOpenLibrary?.('expert')}>
              打开专家库 <ArrowUpRight size={13} />
            </button>
          ) : null}
          <button type="button" disabled={loading || busy} onClick={refreshAll}>
            <RefreshCw size={13} />
            刷新
          </button>
        </div>
      </header>
      {props.section === 'skill' && (
        <SkillLearningRequest
          port={props.learningPort}
          source={props.skillLearningSource}
          onStaged={refreshAll}
        />
      )}
      {props.section === 'schedule' && (
        <CentralLearningStatus
          key={props.runtime?.cwd ?? 'unavailable'}
          runtime={props.runtime}
          refreshKey={(props.refreshKey ?? 0) + refresh}
        />
      )}
      {props.section === 'schedule' && (
        <CentralRuntimeBudgetPanel
          runtime={props.runtime}
          refreshKey={(props.refreshKey ?? 0) + refresh}
          onChanged={refreshAll}
        />
      )}
      {notice ? (
        <p className="agent-workspace__notice" role="status">
          {notice}
        </p>
      ) : null}
      {data.errors.filter((e) => !module || e.domain === props.section).length ? (
        <details className="agent-workspace__read-errors">
          <summary>部分内容暂时未读到</summary>
          {data.errors
            .filter((e) => !module || e.domain === props.section)
            .map((e, i) => (
              <p key={e.domain + i}>
                {domainLabels[e.domain]}：{e.message}
              </p>
            ))}
        </details>
      ) : null}
      {selected ? (
        <>
          <button
            type="button"
            className="agent-workspace__back"
            disabled={busy}
            onClick={() => {
              setSelectedKey(undefined)
              setDetail(undefined)
              setManage(false)
            }}
          >
            <ArrowLeft size={14} />
            返回{module ? '对象列表' : props.section === 'pending' ? '待审批' : '成果列表'}
          </button>
          <header className="agent-workspace__object">
            <div>
              <h3>{selected.title}</h3>
              <p className="agent-workspace__meta">
                {domainLabels[selected.domain]} · {selected.status} ·{' '}
                <span data-tooltip={selected.version}>{versionLabel(selected.version)}</span>
              </p>
              <p className="agent-workspace__source">
                {selected.source}
                {selected.date ? ' · ' + dateLabel(selected.date) : ''}
              </p>
            </div>
            {currentDetail && selected.kind !== 'contract' && selected.kind !== 'acquisition' ? (
              <button type="button" onClick={() => setReader(true)}>
                阅读完整内容 <ArrowUpRight size={13} />
              </button>
            ) : null}
          </header>
          {reading ? (
            <p role="status">正在读取完整内容…</p>
          ) : detailError ? (
            <p role="alert">
              {detailError}{' '}
              <button type="button" onClick={() => void select(selected)}>
                重试读取
              </button>
            </p>
          ) : null}
          {selected.kind === 'contract' && props.runtime ? (
            <ToolContractReview
              runtime={props.runtime}
              proposalId={selected.id}
              onSettled={refreshAll}
            />
          ) : selected.kind === 'acquisition' && props.runtime ? (
            manage ? (
              <ToolProductionPanel
                runtime={props.runtime}
                initialVersionId={string(selected.raw.candidateVersionId) || undefined}
              />
            ) : (
              <ToolAcquisitionReview
                runtime={props.runtime}
                jobId={selected.id}
                workspaceId={string(selected.raw.workspaceId)}
                onClose={() => setSelectedKey(undefined)}
                onOpenProduction={() => setManage(true)}
                onBusyChange={setBusy}
              />
            )
          ) : selected.kind === 'issue' ? (
            <>
              <p className="agent-workspace__lead">{selected.summary}</p>
              <CollaborationIssueDetails
                issue={selected.raw as unknown as CollaborationIssueViewV1}
                onOpenDependency={(owner, id) =>
                  owner === 'skill'
                    ? (() => {
                        const item = data.items.find(
                          (item) =>
                            item.kind === 'pending' && item.domain === 'skill' && item.id === id,
                        )
                        if (item) void select(item)
                        else setNotice('暂未读到这条技能提案，请刷新后重试。')
                      })()
                    : props.onOpenLibrary?.(owner, id)
                }
              />
              {selected.pending ? (
                resolving ? (
                  <ResolveCollaborationIssue
                    disabled={busy}
                    onResolve={(reason) => void resolve(reason)}
                    onCancel={() => setResolving(false)}
                  />
                ) : (
                  <button type="button" onClick={() => setResolving(true)}>
                    记录问题解决结果
                  </button>
                )
              ) : null}
            </>
          ) : currentDetail ? (
            <>
              {selected.kind === 'learned' ? (
                <AgentDomainContent
                  domain={selected.domain as AgentLearningDomain}
                  content={object(selected.raw.content)}
                  related={list(selected.raw.related).map(object)}
                />
              ) : (
                <div className="agent-workspace__document">
                  <LearningMarkdown content={currentDetail.document.content} />
                </div>
              )}
              {selected.kind === 'pending' ? (
                <div className="agent-workspace__decision">
                  {changedRequestedVersion ? (
                    <p role="alert">
                      提案版本已变化，请重新审阅当前版本后再决定。
                      <button
                        type="button"
                        disabled={busy || reading}
                        onClick={() => {
                          if (requestedReview) void select(selected, requestedReview.requestRef)
                        }}
                      >
                        重新审阅当前版本
                      </button>
                    </p>
                  ) : null}
                  <p>
                    {currentDetail.document.approvalIssue ||
                      (!currentDetail.hash
                        ? '未取得完整内容标识，请重新读取后决定。'
                        : '批准这份已读取的完整内容，写入目标文件。')}
                  </p>
                  <div className="agent-workspace__actions">
                    <button
                      type="button"
                      className="agent-workspace__primary"
                      disabled={
                        busy ||
                        !currentDetail.hash ||
                        !!currentDetail.document.approvalIssue ||
                        changedRequestedVersion
                      }
                      onClick={() => setConfirm(true)}
                    >
                      批准并写入
                    </button>
                    <button type="button" disabled={busy} onClick={() => void discard()}>
                      忽略此提案
                    </button>
                  </div>
                  {confirm ? (
                    <div className="agent-workspace__confirmation">
                      <p>确认写入「{selected.title}」的当前审阅版本？</p>
                      <button type="button" disabled={busy} onClick={() => void applyPending()}>
                        确认写入
                      </button>
                      <button type="button" disabled={busy} onClick={() => setConfirm(false)}>
                        返回检查
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {selected.kind === 'production' ? (
                <>
                  <button type="button" onClick={() => setManage((v) => !v)}>
                    {manage ? '收起版本管理' : '审阅与管理此工具版本'}
                  </button>
                  {manage ? (
                    <ToolProductionPanel runtime={props.runtime} initialVersionId={selected.id} />
                  ) : null}
                </>
              ) : null}
              {selected.domain === 'expert' ? (
                <button
                  type="button"
                  onClick={() =>
                    props.onOpenLibrary?.(
                      'expert',
                      selected.kind === 'expert-request' ? selected.id : undefined,
                    )
                  }
                >
                  打开专家库{selected.pending ? '处理此申请' : '查看与管理'}
                </button>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <>
          {props.section === 'approved' ? (
            <div className="agent-workspace__tabs">
              <button type="button" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>
                全部成果
              </button>
              <button
                type="button"
                aria-pressed={tab === 'receipts'}
                onClick={() => setTab('receipts')}
              >
                本次批准记录 {receipts.length || ''}
              </button>
            </div>
          ) : null}
          {props.section === 'approved' && tab === 'receipts' ? (
            receipts.length ? (
              <ul className="agent-workspace__receipts">
                {receipts.map((r) => (
                  <li key={r.item.key + ':' + r.at}>
                    <button
                      type="button"
                      onClick={() => {
                        setDetail({ key: r.item.key, document: r.document })
                        setReader(true)
                      }}
                    >
                      {r.item.title} · {r.action}
                    </button>
                    <span>{dateLabel(r.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>本次打开学习页后尚未批准内容。保存的内容可从“全部成果”重新打开。</p>
            )
          ) : (
            <>
              {!module ? (
                <div className="agent-workspace__filters" aria-label="按子模块筛选">
                  <button
                    type="button"
                    aria-pressed={filter === 'all'}
                    onClick={() => setFilter('all')}
                  >
                    全部 {countLabel()}
                  </button>
                  {(Object.keys(domainLabels) as WorkspaceDomain[]).map((d) => (
                    <button
                      type="button"
                      key={d}
                      aria-pressed={filter === d}
                      onClick={() => setFilter(d)}
                    >
                      {domainLabels[d]} {countLabel(d)}
                    </button>
                  ))}
                </div>
              ) : null}
              <label className="agent-workspace__search">
                <Search size={14} />
                <input
                  type="search"
                  aria-label="查找学习内容"
                  placeholder="查找名称、来源或内容…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              {loading && !rows.length ? (
                <p role="status">正在读取各子模块的内容…</p>
              ) : rows.length ? (
                <table className="agent-workspace__table">
                  <thead>
                    <tr>
                      <th>对象</th>
                      <th>来源</th>
                      <th>状态与版本</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((item) => (
                      <tr key={item.key}>
                        <td>
                          <button type="button" onClick={() => void select(item)}>
                            {item.title}
                          </button>
                          <p>{item.summary}</p>
                        </td>
                        <td>
                          {item.source}
                          <p>
                            {domainLabels[item.domain]}
                            {item.date ? ' · ' + dateLabel(item.date) : ''}
                          </p>
                        </td>
                        <td>
                          {item.status}
                          <p className="agent-workspace__version" data-tooltip={item.version}>
                            {versionLabel(item.version)}
                          </p>
                        </td>
                        <td>
                          <button
                            type="button"
                            aria-label={'打开' + item.title}
                            onClick={() => void select(item)}
                          >
                            <ArrowUpRight size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="agent-workspace__empty">
                  <FileText size={19} />
                  <p>
                    {props.section === 'pending' && data.errors.length
                      ? '待审批内容尚未读全，暂时无法确认是否为空。'
                      : search
                        ? '没有匹配的内容。'
                        : props.section === 'pending'
                          ? '当前筛选没有待决定事项。'
                          : '这个模块尚无已保存的内容。'}
                  </p>
                  {search ? (
                    <button type="button" onClick={() => setSearch('')}>
                      清除搜索
                    </button>
                  ) : null}
                </div>
              )}
            </>
          )}
        </>
      )}
      {reader && detail ? (
        <LearningDocumentReader
          title={selected?.title || '批准时的完整内容'}
          document={detail.document}
          status={selected?.status || '本次批准内容 · 只读'}
          onClose={() => setReader(false)}
        />
      ) : null}
    </section>
  )
}
