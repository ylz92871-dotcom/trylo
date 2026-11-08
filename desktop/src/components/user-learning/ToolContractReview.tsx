import { useEffect, useState } from 'react'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import {
  readToolContract,
  approveToolContract,
  type ToolContractReview as Review,
} from '../../tool-learning/cli-contract'
import { LearningDocumentReader } from './LearningDocumentReader'

export function ToolContractReview({
  runtime,
  proposalId,
  onSettled,
}: {
  readonly runtime: ToolLearningRuntime
  readonly proposalId: string
  readonly onSettled?: () => void
}) {
  const [review, setReview] = useState<Review>(),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0),
    [reader, setReader] = useState(false),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false)
  useEffect(() => {
    const c = new AbortController()
    setReview(undefined)
    setError('')
    void readToolContract(runtime, proposalId, c.signal).then(
      (v) => {
        if (!c.signal.aborted) setReview(v)
      },
      (e) => {
        if (!c.signal.aborted) setError(String(e))
      },
    )
    return () => c.abort()
  }, [runtime, proposalId, refresh])
  async function approve() {
    if (!review || busy) return
    setBusy(true)
    setError('')
    try {
      await approveToolContract(runtime, review, new AbortController().signal)
      setConfirm(false)
      setRefresh((v) => v + 1)
      onSettled?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const raw = review ? JSON.stringify(review.raw, null, 2) : ''
  return (
    <section className="agent-contract-review" aria-busy={busy}>
      {error ? (
        <p role="alert">
          读取或处理未完成：{error}{' '}
          <button type="button" onClick={() => setRefresh((v) => v + 1)}>
            重新读取
          </button>
        </p>
      ) : null}
      {!review && !error ? <p role="status">正在读取完整调用约定与审阅版本…</p> : null}
      {review ? (
        <>
          <p className="agent-workspace__meta">
            父候选 · {String(review.proposal.parentVersionId ?? '')} ·{' '}
            {review.approved ? '已批准修订' : '待决定'}
          </p>
          {review.changes.map((change, i) => (
            <section key={String(change.sampleId ?? i)}>
              <h4>样例 {String(change.sampleId ?? i + 1)}</h4>
              <div className="agent-workspace__change">
                <div>
                  <span>原预期</span>
                  <pre>{JSON.stringify(change.oldExpected, null, 2)}</pre>
                </div>
                <div>
                  <span>拟议新预期</span>
                  <pre>{JSON.stringify(change.newExpected, null, 2)}</pre>
                </div>
              </div>
            </section>
          ))}
          <div className="agent-workspace__actions">
            <button type="button" onClick={() => setReader(true)}>
              阅读完整调用约定
            </button>
            {!review.approved ? (
              <button type="button" disabled={busy} onClick={() => setConfirm(true)}>
                授权此约定修订
              </button>
            ) : null}
          </div>
          {confirm ? (
            <div className="agent-workspace__confirmation">
              <p>批准此审阅版本后，等待这项修订的原学习任务会继续处理。</p>
              <button type="button" disabled={busy} onClick={() => void approve()}>
                确认授权
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirm(false)}>
                返回检查
              </button>
            </div>
          ) : null}
          {reader ? (
            <LearningDocumentReader
              title="调用约定修订"
              document={{
                name: 'contract-revision.json',
                content: '```json\n' + raw + '\n```',
                source: raw,
                metadata: JSON.stringify(
                  { reviewId: review.reviewId, revisionId: review.revisionId },
                  null,
                  2,
                ),
              }}
              status={review.approved ? '已批准修订' : '待审阅修订'}
              onClose={() => setReader(false)}
            />
          ) : null}
        </>
      ) : null}
    </section>
  )
}
