import { useId, useState, type FormEvent } from 'react'
import type { CollaborationIssueViewV1 } from '../../collaboration-learning/issues-client'

const states: Readonly<Record<string, string>> = {
  unreviewed: '等待 Personal Agent 判断',
  resolved: '问题已解决',
  ordinary_execution: '由执行调度处理',
  focused_learning: '已聚焦学习',
  pending: '等待调度',
  queued: '等待调度',
  running: '进行中',
  waiting_evidence: '等待补充信息',
  waiting_dependency: '等待依赖',
  waiting: '等待结果',
  unavailable: '暂不可用',
  failed: '未完成',
  rejected: '未获同意',
  cancelled: '已取消',
  completed: '已完成',
  ready: '已就绪',
  proposed: '已提出',
  planned: '待安排',
  pending_handoff: '等待交接',
  awaiting_handoff: '等待交接',
  applied: '已采用',
  adopted: '已采用',
  retained: '已入库',
  approved: '已同意',
  suspended: '已暂停',
  blocked: '受阻',
}
const owners = { tool: '工具', expert: '专家', skill: '技能' }
export const collaborationStateLabel = (state: string) => states[state] ?? '状态待确认'

export function CollaborationIssueDetails({
  issue,
  onOpenDependency,
}: {
  readonly issue: CollaborationIssueViewV1
  readonly onOpenDependency?: (owner: 'tool' | 'expert' | 'skill', requestId: string) => void
}) {
  return (
    <div className="collaboration-issues__details">
      <details>
        <summary>成员报告（{issue.reports.length}）</summary>
        {issue.reports.map((report) => (
          <section
            key={report.reportId}
            className="collaboration-issues__report"
            aria-label={`成员报告 ${report.memberId}`}
          >
            <p className="collaboration-issues__label">{report.memberId}</p>
            <h4>成员观察</h4>
            <ul>
              {report.facts.map((fact, index) => (
                <li key={index}>{fact}</li>
              ))}
            </ul>
            <h4>原因推测</h4>
            {report.suspectedCauses.length > 0 ? (
              <ul>
                {report.suspectedCauses.map((cause, index) => (
                  <li key={index}>{cause}</li>
                ))}
              </ul>
            ) : (
              <p>暂未提出原因推测。</p>
            )}
            <p className="collaboration-issues__hint">
              引用：{report.evidenceRefs.join('、') || '尚未补充；不影响报告问题。'}
            </p>
          </section>
        ))}
      </details>
      {issue.learning && (
        <section aria-label="中央学习额度">
          <h4>中央学习安排</h4>
          <dl>
            <dt>状态</dt>
            <dd>{collaborationStateLabel(issue.learning.state)}</dd>
            <dt>总模型 tokens</dt>
            <dd>
              额度 {issue.learning.allowance.toLocaleString()} · 已记账{' '}
              {issue.learning.spent.toLocaleString()} · 剩余{' '}
              {issue.learning.remaining.toLocaleString()}
            </dd>
            <dt>额度记录</dt>
            <dd>
              <code>{issue.learning.grantId}</code>
            </dd>
          </dl>
        </section>
      )}
      {issue.dependencies.length > 0 && (
        <section aria-label="学习依赖">
          <h4>依赖进度</h4>
          <ul className="collaboration-issues__records">
            {issue.dependencies.map((dependency) => (
              <li key={dependency.dependencyId}>
                <p>
                  {owners[dependency.owner]} · {collaborationStateLabel(dependency.state)}
                </p>
                {dependency.reason && <p>{dependency.reason}</p>}
                {dependency.approvalStage && (
                  <p className="collaboration-issues__hint">
                    关联审批阶段：
                    {dependency.approvalStage === 'creation' ? '创建前审批' : '长期入库审批'}
                  </p>
                )}
                {dependency.requestId && onOpenDependency && (
                  <button
                    type="button"
                    className="collaboration-issues__button"
                    onClick={() => onOpenDependency(dependency.owner, dependency.requestId!)}
                  >
                    查看{owners[dependency.owner]}原申请
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {issue.adjustments.length > 0 && (
        <section aria-label="协作调整">
          <h4>具体调整</h4>
          {issue.adjustments.map((adjustment) => (
            <details key={adjustment.adjustmentRef}>
              <summary>
                {adjustment.title} · {collaborationStateLabel(adjustment.state)}
              </summary>
              <p className="collaboration-issues__prose">{adjustment.details}</p>
              <dl>
                <dt>相关成员</dt>
                <dd>{adjustment.affectedMembers.join('、') || '尚未指定'}</dd>
                <dt>关联经验版本</dt>
                <dd>
                  {adjustment.experienceVersionIds.length > 0
                    ? adjustment.experienceVersionIds.map((version) => (
                        <code key={version}>
                          {version}
                          <br />
                        </code>
                      ))
                    : '尚未记录'}
                </dd>
              </dl>
            </details>
          ))}
        </section>
      )}
      {issue.feedback.length > 0 && (
        <section aria-label="实际使用反馈">
          <h4>使用反馈</h4>
          <ul>
            {issue.feedback.map((feedback) => (
              <li key={feedback.ref}>
                <p>{feedback.summary}</p>
                <p className="collaboration-issues__hint">
                  来源：{feedback.sourceRefs.join('、') || '尚未提供'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export function ResolveCollaborationIssue({
  disabled,
  onResolve,
  onCancel,
}: {
  readonly disabled: boolean
  readonly onResolve: (reason: string) => void
  readonly onCancel: () => void
}) {
  const id = useId()
  const [reason, setReason] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!disabled && reason.trim()) onResolve(reason.trim())
  }
  return (
    <form onSubmit={submit} className="collaboration-issues__resolution">
      <label htmlFor={id}>解决说明</label>
      <p className="collaboration-issues__hint">
        简述当前如何解决，供 Personal Agent 更新问题和学习安排。
      </p>
      <textarea
        id={id}
        value={reason}
        maxLength={1200}
        rows={3}
        required
        disabled={disabled}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="collaboration-issues__actions">
        <button
          type="submit"
          className="collaboration-issues__button collaboration-issues__button--primary"
          disabled={disabled || !reason.trim()}
        >
          确认已解决
        </button>
        <button
          type="button"
          className="collaboration-issues__button"
          disabled={disabled}
          onClick={onCancel}
        >
          取消
        </button>
      </div>
    </form>
  )
}
