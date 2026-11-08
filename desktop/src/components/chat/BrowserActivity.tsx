import { type ReactElement } from 'react'
import { Check, ChevronDown, CircleAlert, Clock3, LoaderCircle } from 'lucide-react'
import type { PreviewAction, ToolPreviewState } from '../../tooling/tool-preview-state'
import type { BrowserReplay } from '../../tooling/use-browser-replay'
import { browserActionDuration } from '../../tooling/use-browser-replay'
import { browserActionSentence, type BrowserActivityView } from './browser-activity-state'

export function BrowserActivity({ view, state, historyOpen, onHistoryToggle, replay, replaying, onReplay, errors }: {
  readonly view: BrowserActivityView
  readonly state: ToolPreviewState
  readonly historyOpen: boolean
  readonly onHistoryToggle: () => void
  readonly replay?: BrowserReplay
  readonly replaying: boolean
  readonly onReplay: (action: PreviewAction) => void
  readonly errors: readonly string[]
}): ReactElement {
  const history = state.actions ?? []
  const count = state.stepCount ?? history.length
  const issues = [...new Set(errors.filter(Boolean))]
  return <section className="browser-history" data-state={view.mode} aria-label="浏览器操作记录">
    {issues.length > 0 && <div className="browser-history__issues" role="alert"><CircleAlert size={13} aria-hidden="true" /><div>{issues.map(issue => <p key={issue}>{issue}</p>)}</div></div>}
    <div className="browser-history__toolbar"><span>{count ? `本轮已记录 ${count} 项` : '尚无浏览操作'}</span>
      {!replaying && view.action && replay?.[view.action.id] && <button type="button" onClick={() => onReplay(view.action!)}>查看画面</button>}
      <button type="button" className="browser-history__toggle" disabled={!history.length} aria-expanded={historyOpen} aria-controls="browser-operation-history" onClick={onHistoryToggle}>操作记录 <span>{history.length}</span><ChevronDown size={12} /></button>
    </div>
    {historyOpen && history.length > 0 && <ol id="browser-operation-history" className="browser-history__list" aria-label="最近工具操作">
      {history.map((action, index) => <li key={action.id} data-status={action.status}>
        <span className="browser-history__step" aria-hidden="true">{action.status === '已完成' ? <Check size={13} /> : action.status === '失败' ? <CircleAlert size={13} /> : action.status === '执行中' ? <LoaderCircle size={13} /> : <Clock3 size={13} />}</span>
        <div className="browser-history__entry">{replay?.[action.id] ? <button type="button" aria-pressed={replaying && view.action?.id === action.id} title={browserActionSentence(action)} onClick={() => onReplay(action)}><span>{action.title}</span><span>{action.target}</span></button> : <div title={browserActionSentence(action)}><span>{action.title}</span><span>{action.target}</span></div>}
          {action.error && <p>{action.error}</p>}
        </div><div className="browser-history__receipt"><span>{action.status}</span><small>{browserActionDuration(action) || `第 ${action.stepIndex ?? index + 1} 项`}</small></div>
      </li>)}
    </ol>}
  </section>
}
