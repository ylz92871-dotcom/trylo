import type { ToolAcquisitionInquiryReview } from '../../tool-learning/acquisition-inquiry-contract'

const reasons: Readonly<Record<string, string>> = {
  learning_allowance_required: '原任务尚无可用学习额度。', learning_grant_closed: '原任务额度已关闭。', learning_budget_exhausted: '原任务剩余额度不足。',
  learning_claim_active: '原任务仍有正在处理的学习请求，请先等待或检查其状态。', inquiry_running_requires_inspection: '上次续查尚未确认结束。',
  inquiry_attempt_limit: '已达到原续查任务的处理次数上限。', inquiry_terminal: '本次续查已结束，不能直接重跑。',
  acquisition_stop_unconfirmed: '原获取进程尚未确认停止。', acquisition_plan_already_frozen: '获取清单已经冻结，请继续原清单的审阅流程。',
  inquiry_outcome_committed: '续查结果已保存。',
  inquiry_waiting_for_new_evidence: '已有续查仍在等待新依据，同一失败事实不会再次调用模型。',
  acquisition_receipt_requires_inspection: '获取回执尚需确认，请先检查原获取状态。',
  acquisition_already_installed: '隔离获取已经完成，请继续原适配审阅。',
  acquisition_adaptation_requires_inspection: '原适配仍在处理，请先等待或检查其状态。',
  inquiry_evidence_capacity: '原任务的依据引用已达到上限，不能继续追加续查。',
}
const actions: Readonly<Record<string, string>> = { reuse: '复用现有工具', refine: '修正工具用法', defer: '等待或停止', research: '进一步调查',
  adapt: '改造已有 npm 工具', revise_contract: '审阅契约纠正', create: '新建工具', improve: '改进纯工具', compose: '组合已有工具', acquire: '审阅新的获取选择' }
export function ToolAcquisitionInquiry(props: {
  readonly review?: ToolAcquisitionInquiryReview
  readonly error?: string
  readonly busy: boolean
  readonly operation?: string
  readonly blocked: boolean
  readonly canMutate: boolean
  readonly onReview: () => void
  readonly onConfirm: () => void
  readonly onRecover: () => void
  readonly onOpenProposal: (jobId: string) => void
}) {
  const review = props.review, remaining = review?.budget.remaining
  return <section className="tool-acquisition-review__inquiry" aria-label="获取失败续查">
    <h5>按原任务续查</h5>
    <p>调查失败原因与替代方案，使用原任务的剩余额度。新的获取或适配仍需单独审阅。</p>
    {props.error ? <p role="alert">暂时无法确认续查状态（<code>{props.error}</code>），请重新读取后再决定。</p> : null}
    {props.operation === 'review_inquiry' ? <p role="status">正在读取续查审阅与剩余额度…</p> : null}
    {review ? <>
      <p>{remaining ? `原额度剩余 ${remaining.calls} 次模型调用、${remaining.tokens.toLocaleString()} tokens。`
        : review.budget.status === 'not_funded' ? '原任务尚无学习额度。' : '当前无法确认剩余额度。'}此步骤不会补充额度。</p>
      {review.code ? <p role="status">{reasons[review.code] ?? '续查需要先处理已记录的条件。'} <code>{review.code}</code></p> : null}
      {props.operation === 'inquiry' ? <p role="status">正在按本次确认续查。新的待审方案会保留原决定与失败依据。</p> : null}
      {props.operation === 'recover_inquiry' ? <p role="status">正在确认原续查的中断状态…</p> : null}
      {review.outcome?.status === 'proposed' && review.outcome.reviewJobId ? <p>研究已提出新的待审获取方案。原方案保持原样；若新方案尚不能读取，可先同步已保存研究结果。</p> : null}
      {review.outcome?.status === 'proposed' && !review.outcome.reviewJobId ? <p>本次研究仅保存了策略提案。可审阅以下假设；此处不会执行该策略，也没有新的获取授权。</p> : null}
      {review.outcome?.status === 'waiting_evidence' ? <p>{review.ready ? '此前续查已停止；可按本次审阅明确续查，仍使用原额度：' : '本次续查仍需补充依据：'}<code>{review.outcome.code}</code>。没有自动获取或适配。</p> : null}
      {review.recovery ? <p>原续查第 {review.recovery.attempt} 次处理尚未确认结束。{review.recovery.recoverable
        ? '其持有期限已过，可明确确认中断恢复；这不会重发模型调用。' : '持有期限未过或状态仍不可恢复，请保留进度并稍后读取。'}</p> : null}
      {review.outcome?.proposal ? <details><summary>待审策略（模型假设）</summary>
        <p>这是研究提出的策略，尚未执行或验证；不会自动获取、改造或激活工具。</p>
        <dl><dt>建议策略</dt><dd>{actions[review.outcome.proposal.action]}</dd>
          <dt>现有不足</dt><dd>{review.outcome.proposal.existingInsufficiency}</dd><dt>提出理由</dt><dd>{review.outcome.proposal.rationale}</dd>
          <dt>预期收益</dt><dd>{review.outcome.proposal.expectedBenefit}</dd><dt>建设成本</dt><dd>{review.outcome.proposal.constructionCost}</dd>
          <dt>策略记录</dt><dd><code>{review.outcome.proposal.planningDecisionVersionId}</code></dd></dl>
        {review.outcome.proposal.alternatives.length ? <><p>比较过的其他方案</p><ul>{review.outcome.proposal.alternatives.map((alternative, index) => <li key={index}>{alternative}</li>)}</ul></> : null}
      </details> : null}
      <details><summary>查看续查绑定</summary><dl><dt>失败依据</dt><dd><code>{review.failureRef}</code></dd>
        <dt>续查任务</dt><dd><code>{review.inquiryJobId}</code></dd><dt>处理次数</dt><dd>{review.attempt}</dd>
        {review.reviewId ? <><dt>本次确认</dt><dd><code>{review.reviewId}</code></dd></> : null}
        {review.recovery?.reviewId ? <><dt>中断恢复确认</dt><dd><code>{review.recovery.reviewId}</code></dd></> : null}
      </dl></details>
    </> : null}
    <div className="tool-acquisition-review__actions">
      <button type="button" disabled={props.busy} onClick={props.onReview}>{review ? '重新读取续查状态' : '审阅原任务续查'}</button>
      {review?.ready || review?.outcome ? <button type="button" disabled={props.busy || props.blocked || !props.canMutate || !!props.error} onClick={props.onConfirm}>{review.ready ? '使用原额度续查' : '同步已保存研究结果'}</button> : null}
      {review?.recovery?.recoverable ? <button type="button" disabled={props.busy || props.blocked || !props.canMutate || !!props.error} onClick={props.onRecover}>确认中断续查已结束</button> : null}
      {review?.outcome?.status === 'proposed' && review.outcome.reviewJobId ? <button type="button" disabled={props.busy} onClick={() => props.onOpenProposal(review.outcome!.reviewJobId!)}>查看新待审方案</button> : null}
    </div>
  </section>
}
