import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import { CentralBudgetCommandError, readCentralRuntimeBudget, setCentralRuntimeBudgetLimits,
  type CentralBudgetChange, type CentralBudgetReply, type CentralBudgetResources } from '../../agent-learning/central-runtime-budget'
import './central-runtime-budget-panel.css'

type ReadState = { readonly state: 'loading' } | { readonly state: 'failed'; readonly message: string }
  | { readonly state: 'ready'; readonly value: CentralBudgetReply }
type SaveState = 'idle' | 'saving' | 'uncertain'
const labels = { tokens: '总 token', calls: '模型调用', steps: '学习步骤' } as const
const keys = ['tokens', 'calls', 'steps'] as const
const empty = { tokens: '', calls: '', steps: '' }
const asDraft = (value: CentralBudgetResources) => ({ tokens: String(value.tokens), calls: String(value.calls), steps: String(value.steps) })
const errorMessage = (error: unknown) => error instanceof CentralBudgetCommandError
  ? error.outcome === 'unknown' ? '提交结果尚未确认。保持当前数值重试，可核对同一次变更。'
    : error.reason === 'learning_budget_stale' ? '预算在编辑期间发生变化，请刷新后重新核对。'
      : error.reason === 'learning_budget_exhausted' ? '累计上限不能低于已占用额度，未确认费用也会保留。'
        : '预算未保存，请刷新当前工作区后重试。'
  : '暂时无法读取预算，请稍后刷新。'

/** User-only cumulative authorization editor. It never opens a root or enables learning. */
export function CentralRuntimeBudgetPanel(props: { readonly runtime?: ToolLearningRuntime; readonly refreshKey?: number;
  readonly onChanged?: () => void }) {
  const runtime = props.runtime
  const [read, setRead] = useState<ReadState>({ state: 'loading' }), [refresh, setRefresh] = useState(0)
  const [expanded, setExpanded] = useState(false), [draft, setDraft] = useState(empty)
  const [save, setSave] = useState<SaveState>('idle'), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const pending = useRef<{ readonly signature: string; readonly change: CentralBudgetChange }>()
  const submission = useRef<AbortController>(), generation = useRef(0)
  useEffect(() => {
    generation.current += 1
    pending.current = undefined
    submission.current?.abort()
    setSave('idle');setError('');setNotice('');setExpanded(false)
    return () => submission.current?.abort()
  }, [runtime?.cwd, runtime?.cliPath, runtime?.process, runtime?.nodeProgram])
  useEffect(() => {
    if (!runtime) return
    const controller = new AbortController()
    setRead({ state: 'loading' })
    void readCentralRuntimeBudget(runtime, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setRead({ state: 'ready', value })
      if (!pending.current && value.budget) setDraft(asDraft(value.budget.limits))
    }, failure => { if (!controller.signal.aborted) setRead({ state: 'failed', message: errorMessage(failure) }) })
    return () => controller.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Process, executable and workspace fields define this read lifecycle, not its transient wrapper.
  }, [runtime?.cwd, runtime?.cliPath, runtime?.process, runtime?.nodeProgram, props.refreshKey, refresh])
  const value = read.state === 'ready' ? read.value : undefined
  const budget = value?.budget
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!runtime || !budget || save === 'saving') return
    const limits = { tokens: Number(draft.tokens), calls: Number(draft.calls), steps: Number(draft.steps) }
    if (keys.some(key => !/^\d+$/.test(draft[key]) || !Number.isSafeInteger(limits[key]) || limits[key] > 1_000_000_000 || limits[key] < budget.occupied[key])) {
      setError('请输入不低于已占用额度的整数累计上限。');return
    }
    const signature = JSON.stringify([runtime.cwd, budget.rootRef, limits])
    if (pending.current?.signature !== signature) pending.current = { signature, change: {
      rootRef: budget.rootRef, expectedSequence: budget.boardSequence, changeId: `user-budget:${crypto.randomUUID()}`, limits } }
    const change = pending.current.change, currentGeneration = generation.current, controller = new AbortController()
    submission.current = controller
    setSave('saving');setError('');setNotice('')
    try {
      const result = await setCentralRuntimeBudgetLimits(runtime, change, controller.signal)
      if (controller.signal.aborted || currentGeneration !== generation.current) return
      pending.current = undefined
      setRead({ state: 'ready', value: result });setSave('idle');setExpanded(false)
      if (result.budget) setDraft(asDraft(result.budget.limits))
      setNotice(result.wake?.status === 'sent' ? '累计上限已保存，已通知当前学习继续处理。'
        : result.wake?.status === 'unconfirmed' ? '累计上限已保存，学习通知尚未确认。可在学习控制中手动继续。'
          : result.enabled ? '累计上限已保存；学习按当前运行状态等待后续处理。' : '累计上限已保存；学习仍处于停用状态。')
      props.onChanged?.()
    } catch (failure) {
      if (controller.signal.aborted || currentGeneration !== generation.current) return
      if (failure instanceof CentralBudgetCommandError && failure.outcome === 'rejected') pending.current = undefined
      setError(errorMessage(failure))
      setSave(failure instanceof CentralBudgetCommandError && failure.outcome === 'unknown' ? 'uncertain' : 'idle')
    }
  }
  return <section className="central-runtime-budget-panel" aria-label="累计学习预算管理">
    <header><div><h3>累计授权管理</h3><p>调整当前工作区的总上限；每轮任务共用同一份额度。</p></div>
      <div className="central-runtime-budget-panel__actions">
        <button type="button" disabled={!runtime || save === 'saving'} onClick={() => setRefresh(item => item + 1)}>刷新</button>
        <button type="button" aria-expanded={expanded} disabled={!budget || save === 'saving'} onClick={() => { setExpanded(item => !item);setError('') }}>调整累计上限</button>
      </div></header>
    {!runtime ? <p>当前学习运行时尚未就绪。</p> : read.state === 'loading' ? <p role="status">正在读取原预算…</p>
      : read.state === 'failed' ? <p role="alert">{read.message}</p> : !budget ? <p>当前工作区尚无中央预算。首次启用学习时，正常任务会按初始授权建立预算。</p>
        : expanded && <form onSubmit={event => { void submit(event) }} aria-busy={save === 'saving'}>
          <table><thead><tr><th scope="col">资源</th><th scope="col">当前累计总额</th><th scope="col">已占用</th><th scope="col">剩余</th></tr></thead>
            <tbody>{keys.map(key => <tr key={key}><th scope="row">{labels[key]}</th><td>{budget.limits[key].toLocaleString()}</td>
              <td>{budget.occupied[key].toLocaleString()}</td><td className="central-runtime-budget-panel__remaining">{budget.available[key].toLocaleString()}</td></tr>)}</tbody></table>
          <p className="central-runtime-budget-panel__hint">已占用包含已发生费用和未结算预留。修改总额会保留这些占用，新任务不会重置。</p>
          {budget.status === 'held' && <p role="status">当前仍暂停新投入；调整授权不会抹去未确认费用或超额记录。</p>}
          {value?.enabled === false && <p role="status">学习已停用，更新预算不会自动开启。</p>}
          <div className="central-runtime-budget-panel__fields">{keys.map(key => <label key={key}><span>新的{labels[key]}累计上限</span>
            <input type="number" min={budget.occupied[key]} max={1_000_000_000} step={1} required value={draft[key]} disabled={save === 'saving'}
              onChange={event => { pending.current = undefined;setDraft(old => ({ ...old, [key]: event.target.value }));setSave('idle') }} />
          </label>)}</div>
          <button className="agent-workspace__primary" type="submit" disabled={save === 'saving'}>{save === 'saving' ? '正在保存…' : save === 'uncertain' ? '核对并重试同次变更' : '保存累计上限'}</button>
        </form>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>
}
