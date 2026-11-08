import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type {
  CollaborationIssuesClient,
  CollaborationIssuesSnapshotV1,
} from '../../collaboration-learning/issues-client'
import {
  CollaborationIssueDetails,
  collaborationStateLabel,
  ResolveCollaborationIssue,
} from './CollaborationIssueDetails'
import './collaboration-issues.css'

export type CollaborationIssuesPanelProps = {
  readonly workspaceRoot: string
  readonly client: CollaborationIssuesClient
  readonly onDiscuss?: (issueId: string) => void
  readonly onOpenDependency?: (owner: 'tool' | 'expert' | 'skill', requestId: string) => void
}
type Source = { readonly scope: string; readonly client: CollaborationIssuesClient }
type View = Source &
  (
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly snapshot: CollaborationIssuesSnapshotV1 }
    | { readonly kind: 'error'; readonly message: string; readonly code: string }
  )
type Lifetime = Source & { readonly controller: AbortController }
type Operation =
  | { readonly kind: 'idle' }
  | { readonly kind: 'resolving'; readonly issueId: string }
  | { readonly kind: 'refresh_required' }
type Notice = {
  readonly kind: 'status' | 'error'
  readonly message: string
  readonly code?: string
}

function scopeIdentity(scope: string) {
  const normalized = scope.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

/** Read-only owner projection; only an explicit user resolution sends a CAS command. */
export function CollaborationIssuesPanel({
  workspaceRoot,
  client,
  onDiscuss,
  onOpenDependency,
}: CollaborationIssuesPanelProps) {
  const titleId = useId()
  const [view, setView] = useState<View>({ kind: 'loading', scope: workspaceRoot, client })
  const [operation, setOperation] = useState<Operation>({ kind: 'idle' })
  const [notice, setNotice] = useState<Notice>()
  const [editing, setEditing] = useState<{ readonly issueId: string; readonly revision: number }>()
  const lifetime = useRef<Lifetime>()
  const current = useCallback(
    (active: Lifetime) => lifetime.current === active && !active.controller.signal.aborted,
    [],
  )

  const read = useCallback(
    async (active: Lifetime, afterResolution = false) => {
      setView({ ...active, kind: 'loading' })
      try {
        const snapshot = await active.client.read(active.scope, active.controller.signal)
        if (!current(active)) return
        if (
          snapshot.schemaVersion !== 1 ||
          scopeIdentity(snapshot.scope) !== scopeIdentity(active.scope)
        ) {
          setView({
            ...active,
            kind: 'error',
            message: '返回状态与当前工作区不一致，已停止显示。请刷新后重试。',
            code: 'workspace_scope_mismatch',
          })
          setOperation({ kind: 'refresh_required' })
          return
        }
        setView({ ...active, kind: 'ready', snapshot })
        setOperation({ kind: 'idle' })
        setEditing(undefined)
        if (afterResolution) setNotice({ kind: 'status', message: '已记录解决说明，状态已刷新。' })
      } catch (error) {
        if (!current(active)) return
        setView({
          ...active,
          kind: 'error',
          message: afterResolution
            ? '解决说明已提交，暂时无法读取最新状态。请刷新确认。'
            : '暂时无法读取协作问题，请刷新后重试。',
          code: error instanceof Error ? error.message : 'read_unavailable',
        })
        setOperation({ kind: 'refresh_required' })
      }
    },
    [current],
  )

  useEffect(() => {
    const active: Lifetime = { scope: workspaceRoot, client, controller: new AbortController() }
    lifetime.current?.controller.abort()
    lifetime.current = active
    setOperation({ kind: 'idle' })
    setNotice(undefined)
    setEditing(undefined)
    void read(active)
    return () => {
      active.controller.abort()
      if (lifetime.current === active) lifetime.current = undefined
    }
  }, [workspaceRoot, client, read])

  const sourceMatches = view.scope === workspaceRoot && view.client === client
  const snapshot = sourceMatches && view.kind === 'ready' ? view.snapshot : undefined
  const loading = !sourceMatches || view.kind === 'loading'
  const busy = sourceMatches && operation.kind === 'resolving'
  const canMutate = snapshot !== undefined && operation.kind === 'idle'
  const refresh = () => {
    const active = lifetime.current
    if (!active || active.scope !== workspaceRoot || active.client !== client || loading || busy)
      return
    setNotice(undefined)
    setEditing(undefined)
    void read(active)
  }
  async function resolve(reason: string) {
    const active = lifetime.current,
      selected = editing
    if (
      !active ||
      active.scope !== workspaceRoot ||
      active.client !== client ||
      !current(active) ||
      !selected ||
      !canMutate ||
      !reason.trim()
    )
      return
    setOperation({ kind: 'resolving', issueId: selected.issueId })
    setNotice(undefined)
    try {
      const result = await active.client.resolve(
        active.scope,
        {
          schemaVersion: 1,
          action: 'resolve',
          issueId: selected.issueId,
          expectedRevision: selected.revision,
          reason: reason.trim(),
        },
        active.controller.signal,
      )
      if (!current(active)) return
      if (result.schemaVersion !== 1 || !result.ok) {
        setNotice({
          kind: 'error',
          message: '未能确认问题已解决。请刷新状态后重新确认。',
          code:
            result.schemaVersion === 1 && !result.ok ? result.reason : 'unsupported_control_reply',
        })
        setOperation({ kind: 'refresh_required' })
        return
      }
      await read(active, true)
    } catch (error) {
      if (!current(active)) return
      setNotice({
        kind: 'error',
        message: '未能确认更新结果。请刷新状态后再操作。',
        code: error instanceof Error ? error.message : 'resolve_unavailable',
      })
      setOperation({ kind: 'refresh_required' })
    }
  }

  return (
    <section className="collaboration-issues" aria-labelledby={titleId} aria-busy={loading || busy}>
      <header className="collaboration-issues__header">
        <div>
          <h2 id={titleId}>协作问题</h2>
          <p className="collaboration-issues__hint">当前工作区：{workspaceRoot}</p>
        </div>
        <button
          type="button"
          className="collaboration-issues__button"
          disabled={loading || busy}
          onClick={refresh}
        >
          刷新状态
        </button>
      </header>
      {loading && <p role="status">正在读取问题、安排和依赖进度…</p>}
      {sourceMatches && view.kind === 'error' && (
        <div role="alert">
          <p>{view.message}</p>
          <details>
            <summary>诊断信息</summary>
            <code>{view.code}</code>
          </details>
        </div>
      )}
      {sourceMatches && notice && (
        <div role={notice.kind === 'error' ? 'alert' : 'status'}>
          <p>{notice.message}</p>
          {notice.code && (
            <details>
              <summary>诊断信息</summary>
              <code>{notice.code}</code>
            </details>
          )}
        </div>
      )}
      {snapshot && snapshot.issues.length === 0 && (
        <p className="collaboration-issues__empty">
          尚无协作问题。成员可在正常进度中反馈，Personal Agent 会结合最新情况决定如何处理。
        </p>
      )}
      {snapshot?.issues.map((issue) => (
        <article
          key={issue.issueId}
          className="collaboration-issues__item"
          aria-label={issue.title}
        >
          <div className="collaboration-issues__heading">
            <h3>{issue.title}</h3>
            <span>{collaborationStateLabel(issue.decision)}</span>
          </div>
          {issue.reason && (
            <p className="collaboration-issues__prose">Personal Agent：{issue.reason}</p>
          )}
          <CollaborationIssueDetails
            issue={issue}
            {...(onOpenDependency ? { onOpenDependency } : {})}
          />
          <div className="collaboration-issues__actions">
            {onDiscuss && (
              <button
                type="button"
                className="collaboration-issues__button"
                onClick={() => onDiscuss(issue.issueId)}
              >
                与 Personal Agent 讨论
              </button>
            )}
            {issue.decision !== 'resolved' && (
              <button
                type="button"
                className="collaboration-issues__button"
                disabled={!canMutate}
                onClick={() => {
                  setEditing({ issueId: issue.issueId, revision: issue.revision })
                  setNotice(undefined)
                }}
              >
                问题已解决
              </button>
            )}
          </div>
          {editing?.issueId === issue.issueId && (
            <ResolveCollaborationIssue
              key={`${issue.issueId}:${editing.revision}`}
              disabled={!canMutate}
              onResolve={(reason) => {
                void resolve(reason)
              }}
              onCancel={() => setEditing(undefined)}
            />
          )}
          {operation.kind === 'resolving' && operation.issueId === issue.issueId && (
            <p role="status">正在记录解决说明…</p>
          )}
          <details className="collaboration-issues__hint">
            <summary>来源记录</summary>
            <p>
              问题：<code>{issue.issueId}</code> · 版本 {issue.revision}
            </p>
            <p>
              更新时间：<time dateTime={issue.updatedAt}>{issue.updatedAt}</time>
            </p>
          </details>
        </article>
      ))}
    </section>
  )
}
