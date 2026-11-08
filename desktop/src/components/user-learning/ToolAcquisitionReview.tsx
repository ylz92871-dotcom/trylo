import { useEffect, useState } from 'react'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import { useToolAcquisition } from './use-tool-acquisition'
import './tool-acquisition-review.css'
import { LibraryProcessRecovery } from '../app-shell/LibraryProcessRecovery'
import { ToolAcquisitionInquiry } from './ToolAcquisitionInquiry'

function sourceHref(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['github.com', 'registry.npmjs.org', 'www.npmjs.com'].includes(url.hostname) ? url.href : undefined
  } catch { return undefined }
}
const progressLabels: Readonly<Record<string, string>> = {
  queued: '适配已排队', running: '正在准备适配', waiting_approval: '适配候选已保存', waiting_evidence: '适配等待补充依据',
  succeeded: '适配处理结束', failed: '适配处理失败', cancelled: '适配已取消', expired: '本次适配已结束',
}
export function ToolAcquisitionReview(props: {
  readonly runtime?: ToolLearningRuntime
  readonly jobId: string
  readonly workspaceId: string
  readonly onClose: () => void
  readonly onOpenProduction: () => void
  readonly onBusyChange?: (busy: boolean) => void
}) {
  const [followup, setFollowup] = useState<{ readonly origin: string; readonly workspace: string; readonly jobId: string }>()
  const showingFollowup = followup?.origin === props.jobId && followup.workspace === props.workspaceId
  const displayedJobId = showingFollowup ? followup.jobId : props.jobId
  const state = useToolAcquisition(props.runtime, displayedJobId, props.workspaceId)
  useEffect(() => { setFollowup(undefined) }, [props.jobId, props.workspaceId])
  useEffect(() => { props.onBusyChange?.(state.busy) }, [props.onBusyChange, state.busy])
  useEffect(() => () => { props.onBusyChange?.(false) }, [props.onBusyChange])
  const review = state.review, continuation = review?.continuation
  const failure = review?.installation?.installed === true || continuation !== undefined ? undefined : review?.failure
  const failureBlocked = failure !== undefined && failure.recovery !== 'retry_explicitly'
  const unknownRunning = continuation?.state === 'running' && continuation.recovery !== 'committed_candidate'
  const committedRecovery = continuation?.recovery === 'committed_candidate'
  const prepared = continuation?.versionId !== undefined
  const terminal = continuation !== undefined && ['failed', 'cancelled', 'expired', 'succeeded'].includes(continuation.state) && !prepared
  const attemptLimit = continuation?.state === 'waiting_evidence' && continuation.attempt >= 3 && !prepared
  const processOwned = props.runtime?.lifecycle?.canStart !== undefined && props.runtime?.lifecycle?.starting !== undefined
  const href = review ? sourceHref(review.candidate.sourceUrl) : undefined
  return <section className="tool-acquisition-review" aria-label="获取工具审阅" aria-busy={state.loading || state.busy}>
    <div className="tool-acquisition-review__header">
      <h4>{showingFollowup ? '新的待审获取方案' : '获取与适配方案'}</h4>
      <button type="button" onClick={props.onClose} disabled={state.busy}>收起方案</button>
    </div>
    {showingFollowup ? <p>原方案仍保留。以下是续查产生的新待审方案。<button type="button" disabled={state.busy} onClick={() => setFollowup(undefined)}>返回原获取方案</button></p> : null}
    {state.notice ? <p role="status">{state.notice}</p> : null}
    {state.stopPending ? <p role="status">当前工作区仍有进程尚未确认停止，请先确认退出后再继续获取。刷新空进度不会自动重发授权。</p> : null}
    {state.stopPending && props.runtime?.recovery ? <LibraryProcessRecovery port={props.runtime.recovery} /> : null}
    {state.error ? <div role="alert">
      <p>暂时无法确认当前获取方案。请重新读取后再决定。</p>
      <details><summary>查看原因</summary><code>{state.error}</code></details>
      <button type="button" onClick={state.refresh} disabled={state.loading}>重新读取方案</button>
    </div> : null}
    {!review && state.loading ? <p role="status">正在读取所选版本、许可与获取理由…</p> : !review ? null : <>
      <p><strong>{review.candidate.id} · {review.candidate.version}</strong> · {review.candidate.platform} · {review.candidate.licenseSpdx}</p>
      <p>{href ? <a href={href} target="_blank" rel="noreferrer">{review.candidate.sourceUrl}</a> : review.candidate.sourceUrl}</p>
      <dl>
        <dt>现有不足</dt><dd>{review.existingInsufficiency}</dd>
        <dt>选择理由</dt><dd>{review.rationale}</dd>
        <dt>预期收益</dt><dd>{review.expectedBenefit}</dd>
        <dt>建设成本</dt><dd>{review.constructionCost}</dd>
        <dt>适配计划</dt><dd>{review.adaptation}</dd>
      </dl>
      <p className="tool-acquisition-review__muted">以上收益和成本是本次规划的判断，后续真实任务反馈会继续检验。</p>
      {review.alternatives.length ? <details><summary>比较过的其他方案</summary><ul>{review.alternatives.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
      <div className="tool-acquisition-review__progress" role="status">
        <p>{review.installation === undefined ? state.busy && state.operation === 'acquire' ? '本次授权已提交，正在解析依赖清单。' : failure ? '已记录本方案获取时遇到的阻碍，尚未确认获取完成。' : '尚未冻结依赖清单；可审阅后授权获取。'
          : review.installation.installed === true ? `隔离获取已完成，清单包含 ${review.installation.packageCount} 个包。`
            : `已冻结 ${review.installation.packageCount} 个包的依赖清单，尚未确认隔离获取完成。`}</p>
        {continuation ? <p>{committedRecovery ? '候选已保存，等待同步处理结果。' : progressLabels[continuation.state]} · 第 {continuation.attempt} 次处理</p> : null}
        {continuation?.code ? <p>处理原因：<code>{continuation.code}</code></p> : null}
        {continuation?.code === 'tool_cycle_deadline' ? <p>后台时间窗已用完，进度已保留；需要明确续做原任务。</p> : null}
        {state.busy && state.operation === 'acquire' ? <p>正在执行本次授权；下载、安装与适配可能需要几分钟，进度会自动刷新。</p> : null}
      </div>
      {failure ? <div role="status">
        <p>已保存获取依据：<code>{failure.code}</code></p>
        <p>{failure.recovery === 'investigate' ? '当前方案遇到来源、内容或运行方式约束。可先审阅原任务续查，调查替代方案；更换版本或方案仍需重新审阅授权。'
          : failure.recovery === 'await_stop' ? '上次获取进程的停止结果尚未确认。请先确认原进程退出，再决定是否通过 CLI 明确重试。'
            : '原方案遇到暂时阻碍。刷新会读取持久记录；只有明确点击重试才会再次发起获取。'}</p>
        <details><summary>查看已记录的获取阻碍</summary><p>阶段：<code>{failure.phase}</code></p><p>失败依据：<code>{failure.ref}</code></p>
          {failure.diagnostics.length ? <ul>{failure.diagnostics.map((row, index) => <li key={index}>{row.packageName}{row.version ? ` · ${row.version}` : ''} · <code>{row.stage}</code> · <code>{row.code}</code></li>)}</ul> : null}
          <p>这条记录不会自动重试、补充额度或改写原决定；后续明确学习任务可以读取这条依据。</p></details>
        {failure.recovery === 'investigate' ? <ToolAcquisitionInquiry review={state.inquiry} error={state.inquiryError} busy={state.busy}
          operation={state.operation} blocked={state.startBlocked} canMutate={processOwned}
          onReview={() => { void state.reviewInquiry() }} onConfirm={() => { void state.confirmInquiry() }} onRecover={() => { void state.recoverInquiry() }}
          onOpenProposal={jobId => setFollowup({ origin: props.jobId, workspace: props.workspaceId, jobId })} /> : null}
      </div> : null}
      {!prepared && !unknownRunning ? <p>{review.installation?.installed === true && continuation !== undefined
        ? '继续处理会复用已获取的隔离安装与原有学习额度，重新核对字节后准备适配候选。之后还需单独验证与审核。'
        : '这一步会下载所选版本及其依赖，在隔离区安装，并使用可用学习额度准备适配候选。之后还需单独验证与审核。'}</p> : null}
      {unknownRunning && !state.busy && continuation ? <>
        <p>适配仍在处理，或中断结果尚未确认。请先刷新进度，避免重复发起。</p>
        <details><summary>在 CLI 审阅中断恢复方案</summary>
          <p>只有精确租约已过期时才能明确确认恢复。恢复会保留已消耗的额度与原处理次数，不会自动重发模型调用。</p>
          <code>trylo tools acquire-learning {review.jobId} --recover-child {continuation.jobId} --attempt {continuation.attempt} --json</code>
        </details>
      </> : null}
      {review.candidate.platform !== 'npm' ? <p>当前桌面仅接入 npm 获取；此方案请通过 CLI 审阅。</p> : null}
      {terminal ? <p>本次适配已结束，不能直接重跑。请查看处理原因，按新的明确需求继续。</p>
        : attemptLimit ? <p>已达到本次任务的三次处理上限。请保留处理依据，按新的明确需求继续。</p> : null}
      <div className="tool-acquisition-review__actions">
        {state.busy ? <button type="button" onClick={state.cancel}>停止等待并确认进度</button>
          : review.candidate.platform === 'npm' && (!prepared || committedRecovery) ? <button type="button" disabled={state.loading || !!state.error || unknownRunning || terminal || attemptLimit || state.startBlocked || !processOwned || failureBlocked} onClick={() => { void state.approve() }}>
            {committedRecovery ? '同步已保存候选' : review.installation?.installed === true && continuation !== undefined ? '继续准备适配' : failure ? failureBlocked ? '获取阻碍需要先处理' : '按原方案显式重试获取' : review.installation ? '授权继续获取与适配' : '授权获取并准备适配'}
          </button> : null}
        <button type="button" onClick={state.refresh} disabled={state.loading}>刷新获取进度</button>
        {prepared ? <button type="button" onClick={props.onOpenProduction} disabled={state.busy}>查看工具管理</button> : null}
      </div>
      {!processOwned ? <p>当前环境暂不支持获取操作，请通过 CLI 继续。</p> : null}
      <details><summary>查看本次授权标识</summary><dl>
        <dt>获取任务</dt><dd><code>{review.jobId}</code></dd><dt>所选决策</dt><dd><code>{review.approvalId}</code></dd>
        {review.installation ? <><dt>隔离清单</dt><dd><code>{review.installation.installationId}</code></dd></> : null}
        {continuation?.versionId ? <><dt>候选版本</dt><dd><code>{continuation.versionId}</code></dd></> : null}
      </dl></details>
    </>}
  </section>
}
