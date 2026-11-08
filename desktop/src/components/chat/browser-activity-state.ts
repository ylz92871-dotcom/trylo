import type { NativeBrowserNavigationError } from '../../host-adapter/native-browser'
import type { BrowserPreviewController } from '../../tooling/use-browser-preview'
import type { PreviewAction, ToolPreviewState } from '../../tooling/tool-preview-state'

export type BrowserSidebarPhase = 'idle' | 'connecting' | 'executing' | 'waiting' | 'done' | 'disconnected' | 'failed' | 'stopped'
export type BrowserActivityMode = 'idle' | 'connecting' | 'acting' | 'queued' | 'waiting' | 'pending-control' | 'user-control' | 'replay' | 'failed' | 'stopped' | 'disconnected' | 'done'
export interface BrowserActivityView {
  readonly navigationError?: NativeBrowserNavigationError
  readonly phase: BrowserSidebarPhase
  readonly mode: BrowserActivityMode
  readonly owner: string
  readonly title: string
  readonly clocking: boolean
  readonly step?: number
  readonly action?: PreviewAction
}
export function browserActionSentence(action: PreviewAction): string {
  return action.target.trim() ? `${action.title}『${action.target.trim()}』` : action.title
}
export function browserSidebarPhase(state: ToolPreviewState, status: BrowserPreviewController['status'], running = state.active === true, inFlight = 0): BrowserSidebarPhase {
  if (state.settlement?.outcome === 'interrupted') return 'stopped'
  if (status === 'error' || (status === 'stopped' && state.hasStarted)) return 'disconnected'
  if (status === 'starting') return 'connecting'
  if (state.active || inFlight > 0 || state.action?.status === '执行中' || state.action?.status === '待执行') return 'executing'
  if (state.action?.status === '失败' || state.settlement?.outcome === 'failed') return 'failed'
  if (running && state.hasStarted) return 'waiting'
  return state.hasStarted ? 'done' : 'idle'
}
/** Conversation liveness is not an in-flight browser command. */
export function browserActivityView(state: ToolPreviewState, preview: BrowserPreviewController | undefined, running: boolean, replay?: PreviewAction): BrowserActivityView {
  const action = replay ?? state.action ?? state.actions?.at(-1)
  const native = preview?.nativeState
  const phase = browserSidebarPhase(state, preview?.status ?? 'stopped', running, native?.inFlight)
  const base = { phase, action, step: action?.stepIndex, clocking: false }
  if (replay) return { ...base, mode: 'replay', owner: '历史画面', title: browserActionSentence(replay) }
  if (phase === 'disconnected') return { ...base, mode: 'disconnected', owner: '预览断连', title: '浏览器连接已断开' }
  if (phase === 'connecting') return { ...base, mode: 'connecting', owner: '正在连接', title: '正在连接浏览器' }
  if (native?.control === 'user') return { ...base, mode: 'user-control', owner: '你已接管', title: running || state.active ? '等待交回控制权' : '浏览器由你操作' }
  const clocking = preview?.status === 'running' && (state.active === true || (native?.inFlight ?? 0) > 0) && action?.status === '执行中' && action.startedAt !== undefined
  if (native?.control === 'pending') return { ...base, clocking, mode: 'pending-control', owner: '等待当前操作结束', title: '正在移交控制权' }
  const navigationError = native?.tabs?.find(tab => tab.label === native.activeLabel)?.navigationError
  if (!state.active && !(native?.inFlight ?? 0) && navigationError) return { ...base, navigationError, phase: 'failed', mode: 'failed', owner: '页面未打开', title: '检查网址或重试' }
  if (phase === 'stopped' || action?.status === '已中断') return { ...base, mode: 'stopped', owner: '浏览已停止', title: '浏览操作已停止' }
  if (phase === 'failed') {
    const failed = action?.status === '失败' ? action : [...(state.actions ?? [])].reverse().find(item => item.status === '失败')
    return { ...base, action: failed, step: failed?.stepIndex, mode: 'failed', owner: failed ? '这一步未完成' : '本轮浏览', title: failed ? browserActionSentence(failed) : '本轮有操作未完成' }
  }
  if (phase === 'executing') {
    const queued = action?.status === '待执行' && (native?.inFlight ?? 0) === 0
    return { ...base, clocking, mode: queued ? 'queued' : 'acting', owner: queued ? '等待执行' : '智能体操作', step: action?.status === '执行中' || action?.status === '待执行' ? action.stepIndex : undefined, title: action && (action.status === '执行中' || action.status === '待执行') ? `${queued ? '等待' : '正在'}${browserActionSentence(action)}` : '正在操作网页' }
  }
  if (phase === 'waiting') return { ...base, mode: 'waiting', owner: '浏览器待命', title: '等待下一步' }
  if (phase === 'done') return { ...base, mode: 'done', owner: '本轮浏览', title: '浏览操作已结束' }
  return { ...base, mode: 'idle', owner: '可直接操作', title: '浏览器已就绪' }
}
