import { useEffect, useState } from 'react'
import { readCentralLearningStatus, type CentralLearningStatus as Snapshot } from '../../agent-learning/central-status'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import './central-learning-status.css'

type Read = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: Snapshot } | { readonly status: 'failed' }
const poolStates = { available: '可继续分配', exhausted: '可用额度已用完', held: '已暂停新投入' }
const stageStates = { qualified: '已形成阶段提案', closed_no_result: '本阶段未形成提案', pending: '结果等待确认' }

/** Displays the original Board projection, with no UI wallet or reset action. */
export function CentralLearningStatus(props: { readonly runtime?: ToolLearningRuntime; readonly refreshKey?: number }) {
  const [read, setRead] = useState<Read>({ status: 'loading' }), [refresh, setRefresh] = useState(0)
  const runtime = props.runtime
  useEffect(() => {
    if (runtime === undefined) return
    const controller = new AbortController()
    setRead({ status: 'loading' })
    void readCentralLearningStatus(runtime, controller.signal).then(value => {
      if (!controller.signal.aborted) setRead({ status: 'ready', value })
    }, () => { if (!controller.signal.aborted) setRead({ status: 'failed' }) })
    return () => controller.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Process, executable and workspace fields define this read lifecycle, not its transient wrapper.
  }, [runtime?.process, runtime?.cliPath, runtime?.cwd, runtime?.nodeProgram, props.refreshKey, refresh])
  return <section className="central-learning-status" aria-label="中央学习预算" aria-busy={read.status === 'loading' && runtime !== undefined}>
    <header><h3>工作区共享预算</h3><button type="button" disabled={!runtime || read.status === 'loading'} onClick={() => setRefresh(value => value + 1)}>刷新预算</button></header>
    {!runtime ? <p>当前学习运行时尚未就绪。</p> : read.status === 'loading' ? <p role="status">正在读取中央预算…</p>
      : read.status === 'failed' ? <p role="status">未读到中央预算，请确认当前使用支持中央学习的新 CLI 后重试。</p>
        : read.value.budget === null ? <p>当前工作区尚未建立中央预算。启用学习设置中的共享预算后，正常任务会按授权建立总池。</p>
          : <>
            <p role="status">{poolStates[read.value.budget.status]}{read.value.budget.status === 'held' ? '。已有费用保留，须先处理未确认用量或超额。' : '。'}</p>
            <div className="central-learning-status__resources"><table>
              <thead><tr><th scope="col">资源</th><th scope="col">总额</th><th scope="col">已占用</th><th scope="col">可用</th></tr></thead>
              <tbody>{(['tokens', 'calls'] as const).map(key => <tr key={key}><th scope="row">{key === 'tokens' ? '总 token' : '模型调用'}</th>
                <td>{read.value.budget!.limits[key].toLocaleString()}</td><td>{read.value.budget!.occupied[key].toLocaleString()}</td>
                <td>{read.value.budget!.available[key].toLocaleString()}</td></tr>)}</tbody>
            </table></div>
            <p className="central-learning-status__hint">中央思考、用户学习与 Agent 各域共用这份预算。占用包含已拨出的未来额度和未确认费用，总池不随新任务重置。</p>
          </>}
    {runtime && read.status === 'ready' && read.value.stages.length > 0 && <details>
      <summary>最近阶段结果（{read.value.stages.length}）</summary>
      <p className="central-learning-status__hint">阶段提案与后续审批、实际采用分别记录。</p>
      <ul>{read.value.stages.slice(-8).reverse().map(stage => <li key={stage.unitId}>{stageStates[stage.outcome]}</li>)}</ul>
    </details>}
  </section>
}
