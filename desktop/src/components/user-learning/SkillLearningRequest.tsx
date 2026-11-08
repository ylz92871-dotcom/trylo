import { useEffect, useRef, useState } from 'react'
import type { LearningPort } from '../../learning/learning-port'

export type SkillLearningSource = { readonly workspaceRoot: string; readonly sessionId: string }

/** Explicit learning uses the selected real conversation; the facade resolves its canonical CLI journal. */
export function SkillLearningRequest(props: { readonly port: LearningPort; readonly source?: SkillLearningSource;
  readonly onStaged: () => void }) {
  const [request, setRequest] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const sourceKey = JSON.stringify(props.source), currentKey = useRef(sourceKey)
  currentKey.current = sourceKey
  useEffect(() => { setRequest(''); setNotice('') }, [sourceKey])
  const learn = async () => {
    if (busy || !props.source || !request.trim()) return
    const source = { ...props.source }, submittedKey = sourceKey, learnRequest = request.trim()
    setBusy(true)
    setNotice('正在从当前对话的真实任务经历整理技能…')
    try {
      const result = await props.port.learnExplicit({ ...source, learnRequest })
      if (currentKey.current !== submittedKey) return
      const count = result.pendingIds?.length ?? (result.pendingId ? 1 : 0)
      if (count > 0) props.onStaged()
      if (result.ok && result.status === 'staged') {
        setNotice(`已形成 ${count} 条待审批提案，请在“待审批”中审阅。`)
      } else if (result.ok && result.status === 'no_learning') {
        setNotice(result.reason === 'central_learning_no_new_investment'
          ? '本次检查已完成，无需新增学习投入。' : '本次审阅未形成技能提案。')
      } else if (result.ok && result.status === 'completed' && result.reason === 'central_skill_already_applied') {
        setNotice('这次来源的技能提案已应用，可在“已批准”记录中查看。')
      } else if (result.ok && result.status === 'waiting') {
        setNotice('中央已接收这次学习要求；请在“学习安排”查看预算、等待条件与阶段结果。')
      } else setNotice(`本次学习未完成：${result.reason ?? result.error ?? result.status ?? '未知结果'}${count > 0 ? `；已有 ${count} 条提案仍可在“待审批”中审阅。` : ''}`)
    } catch {
      if (currentKey.current === submittedKey) setNotice('技能学习服务未返回确认结果，请检查待审批和运行状态。')
    } finally { setBusy(false) }
  }
  return <fieldset className="settings-modal__group" disabled={busy}>
    <legend>从当前对话学习技能</legend>
    <p>说明要保留或修订的做法。按当前学习预算处理，产物须审批后才能安装。</p>
    <label className="settings-modal__field">
      <span>学习要求</span>
      <textarea className="settings-modal__input" value={request} maxLength={2000}
        onChange={event => setRequest(event.target.value)} disabled={!props.source || busy} />
    </label>
    <button type="button" disabled={!props.source || !request.trim() || busy} onClick={() => void learn()}>
      {busy ? '整理中…' : '整理为技能提案'}
    </button>
    {!props.source && <p>先选择一个已完成任务的普通对话。</p>}
    {notice && <p role="status">{notice}</p>}
  </fieldset>
}
