import type { ProductionDetail } from '../../tool-learning/production-contract'
import type { ProductionAction } from '../../tool-learning/cli-production'
import { ToolPurposeDescription, ToolPurposeConditions } from './ToolPurpose'
const actionText = {
  activate: '启用此版本',
  verify: '授权本次验证',
  suspend: '暂停此版本',
  withdraw: '撤回此版本',
  rollback: '回滚到前一版本',
}
const actionDescription = {
  activate: '此版本将提供给当前工作区后续开启工具学习的任务，每次调用仍受任务权限控制。',
  verify: '将运行工具样例、变式、反例和隔离边界探针。本次授权仅用于验证，不会自动启用。',
  suspend: '暂停向后续任务提供此版本。保留来源、验证依据与使用记录，可重新审阅后恢复。',
  withdraw: '撤回后不再提供此版本，保留历史依据。重新采用需要提交新的候选计划。',
  rollback: '仅恢复已有批准、且仍然可用的前一版本；CLI 会重新检查其收据与生命周期。',
}

type Props = {
  readonly detail: ProductionDetail
  readonly kind: ProductionAction['kind']
  readonly disabled: boolean
  readonly onAccept: () => void
  readonly onCancel: () => void
}
export function ToolProductionApproval({ detail, kind, disabled, onAccept, onCancel }: Props) {
  const current = detail.current?.versionId === detail.versionId
  const label =
    kind === 'activate' && detail.lifecycle === 'suspended' ? '恢复此版本' : actionText[kind]
  return (
    <section className="tool-production__approval" aria-label="确认工具操作">
      <h4>{label}</h4>
      <strong className="tool-production__approval-purpose">{detail.capability}</strong>
      <ToolPurposeDescription description={detail.description} />
      <p className="tool-production__meta">
        {detail.packageName} {detail.packageVersion}
      </p>
      <ToolPurposeConditions mastery={detail.mastery} />
      <p>{actionDescription[kind]}</p>
      {kind === 'activate' && detail.current && !current ? (
        <p>将替换当前已批准的同一工具版本，原版本记录保留。</p>
      ) : null}
      <details>
        <summary>本次操作绑定的版本</summary>
        <code>{detail.versionId}</code>
        {kind === 'activate' && detail.review.status === 'available' ? (
          <code>{detail.review.reviewId}</code>
        ) : null}
      </details>
      <div className="tool-production__actions">
        <button
          className="tool-production__primary"
          type="button"
          disabled={disabled}
          onClick={onAccept}
        >
          确认{label}
        </button>
        <button type="button" disabled={disabled} onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  )
}
