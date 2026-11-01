import { ToolProductionEvidence } from './ToolProductionEvidence'
import { ToolProductionApproval } from './ToolProductionApproval'
import { ToolPurposeDescription, ToolPurposeConditions, toolRuntimeLabel } from './ToolPurpose'
import { useEffect, useState } from 'react'
import type { ProductionDetail, ProductionSummary } from '../../tool-learning/production-contract'
import type { ProductionAction } from '../../tool-learning/cli-production'

const labels: Readonly<Record<string, string>> = {
  evaluating: '等待验证',
  shadow: '等待审核',
  awaiting_approval: '等待审核',
  validated: '已验证',
  active: '已启用',
  suspended: '已暂停',
  rejected: '已撤回',
  retired: '已撤回',
  rolled_back: '已回滚',
  draft: '草稿',
  quarantined: '隔离中',
}
export function productionLabel(item: ProductionSummary): string {
  if (item.lifecycle === 'active' && item.current?.versionId !== item.versionId) return '已被替换'
  if (item.lifecycle === 'evaluating')
    return item.checkState === 'running'
      ? '验证未结束'
      : item.checkState === 'failed'
        ? '验证未通过'
        : item.checkState === 'succeeded'
          ? '等待审核'
          : '等待验证'
  return labels[item.lifecycle] ?? item.lifecycle
}
type Props = {
  readonly detail: ProductionDetail
  readonly busy?: ProductionAction['kind']
  readonly disabled: boolean
  readonly onAction: (action: ProductionAction) => Promise<void>
  readonly onBack: () => void
  readonly onCancel: () => void
}

export function ToolProductionDetail({
  detail,
  busy,
  disabled,
  onAction,
  onBack,
  onCancel,
}: Props) {
  const [confirm, setConfirm] = useState<ProductionAction['kind']>()
  useEffect(() => setConfirm(undefined), [detail])
  const current = detail.current?.versionId === detail.versionId
  const canActivate =
    detail.review.status === 'available' &&
    ['evaluating', 'shadow', 'awaiting_approval', 'suspended'].includes(detail.lifecycle)
  const canVerify =
    detail.lifecycle === 'evaluating' && !['running', 'succeeded'].includes(detail.checkState ?? '')
  const canStop = current && ['active', 'suspended'].includes(detail.lifecycle)
  async function accept() {
    if (!confirm) return
    const action =
      confirm === 'activate' && detail.review.status === 'available'
        ? ({
            kind: confirm,
            versionId: detail.versionId,
            reviewId: detail.review.reviewId,
          } as const)
        : confirm === 'activate'
          ? undefined
          : { kind: confirm, versionId: detail.versionId }
    if (action) {
      setConfirm(undefined)
      await onAction(action)
    }
  }
  return (
    <article className="tool-production__detail" aria-label={`${detail.packageName} 版本详情`}>
      <button className="tool-production__back" type="button" onClick={onBack} disabled={!!busy}>
        返回工具列表
      </button>
      {!confirm ? (
        <>
          <header>
            <div className="tool-production__identity">
              <h3>{detail.capability}</h3>
              <span className="tool-production__status">{productionLabel(detail)}</span>
            </div>
            <ToolPurposeDescription description={detail.description} />
            <p className="tool-production__meta">
              {detail.packageName} · {detail.packageVersion}
            </p>
          </header>
          <div className="tool-production__actions">
            {canActivate ? (
              <button
                className="tool-production__primary"
                type="button"
                disabled={disabled}
                onClick={() => setConfirm('activate')}
              >
                {detail.lifecycle === 'suspended' ? '审阅并恢复' : '审阅并启用'}
              </button>
            ) : null}
            {canVerify && !canActivate ? (
              <button type="button" disabled={disabled} onClick={() => setConfirm('verify')}>
                验证此工具
              </button>
            ) : null}
            {canStop && detail.lifecycle === 'active' ? (
              <button type="button" disabled={disabled} onClick={() => setConfirm('suspend')}>
                暂停
              </button>
            ) : null}
            {canStop && detail.current?.previousVersionId ? (
              <button type="button" disabled={disabled} onClick={() => setConfirm('rollback')}>
                回滚
              </button>
            ) : null}
            {canStop || ['evaluating', 'shadow', 'awaiting_approval'].includes(detail.lifecycle) ? (
              <button type="button" disabled={disabled} onClick={() => setConfirm('withdraw')}>
                撤回
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {confirm ? (
        <ToolProductionApproval
          detail={detail}
          kind={confirm}
          disabled={disabled}
          onAccept={() => void accept()}
          onCancel={() => setConfirm(undefined)}
        />
      ) : null}
      {busy ? (
        <p role="status">
          {busy === 'verify' ? '正在运行验证，请等待实际检查结果。' : '正在提交操作并确认状态…'}
          {busy === 'verify' ? (
            <button type="button" onClick={onCancel}>
              取消验证
            </button>
          ) : null}
        </p>
      ) : null}
      {!confirm ? (
        <>
          <ToolPurposeConditions mastery={detail.mastery} />
          <details className="tool-production__technical">
            <summary>验证、来源与运行权限</summary>
            <details className="tool-production__runtime">
              <summary>运行方式与权限</summary>
              <p>
                {toolRuntimeLabel(detail.profile)} · {detail.license} · {detail.dependencyCount}{' '}
                个运行依赖
              </p>
              <p>
                单次上限 {detail.timeoutMs / 1000} 秒。无工作区文件、网络、写入、密钥或子进程权限。
              </p>
            </details>
            <ToolProductionEvidence detail={detail} />
          </details>
          <section>
            <h4>后续任务使用</h4>
            <p>
              {detail.uses.total} 次调用，{detail.uses.returned}{' '}
              次返回结果。调用记录不代表质量或净收益已验证。
            </p>
          </section>
        </>
      ) : null}
    </article>
  )
}
