import { useEffect, useState, type ReactElement } from 'react'
import { ArrowLeft, ArrowRight, MousePointer2, X } from 'lucide-react'
import { Logo } from '../brand/Logo'
import type { BrowserActivityView } from './browser-activity-state'

export function BrowserControlNotice({ view, control, connected, disabled, running, onControl, onReturnLive }: {
  readonly view: BrowserActivityView
  readonly control?: 'agent' | 'pending' | 'user'
  readonly connected: boolean
  readonly disabled: boolean
  readonly running: boolean
  readonly onControl: () => void
  readonly onReturnLive: () => void
}): ReactElement {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!view.clocking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [view.clocking, view.action?.id, view.action?.startedAt])
  const labels: Record<BrowserActivityView['mode'], readonly [string, string]> = {
    acting: ['Trylo 正在操作浏览器', view.title],
    waiting: ['等待下一步操作', '网页保持打开，你可以随时接管'],
    queued: ['网页操作等待执行', view.title],
    'pending-control': ['正在移交控制权', '当前操作结束后，浏览器将交由你操作'],
    'user-control': ['你正在操作浏览器', running ? '浏览器操作已暂停；智能体仍在运行' : '可以直接点击、输入和滚动网页'],
    replay: ['正在查看历史画面', view.title],
    failed: view.navigationError ? ['页面未打开', view.title] : [view.action ? '这一步没有完成' : '本轮有操作未完成', view.action ? view.title : '详情可在对话中查看'],
    stopped: ['浏览操作已停止', '当前网页仍可继续查看'],
    done: ['本轮浏览已结束', '你可以接管，继续查看网页'],
    disconnected: ['浏览器连接已断开', '重新连接后可继续浏览'],
    connecting: ['正在连接浏览器', '连接完成后，网页会显示在这里'],
    idle: ['浏览器已就绪', '输入网址，或让 Trylo 开始浏览'],
  }
  const [title, detail] = labels[view.mode]
  const replaying = view.mode === 'replay'
  const elapsed = view.clocking && view.action?.startedAt !== undefined ? `${Math.max(0, Math.floor((now - view.action.startedAt) / 1000))} 秒` : ''
  return <section className="browser-control" data-state={view.mode} aria-label="浏览器控制状态">
    <span className="browser-control__mark" aria-hidden="true"><Logo size={44} variant="solid" tone="ink" decorative /></span>
    <div className="browser-control__copy" role="status" aria-live="polite"><strong>{title}</strong><span title={detail}>{detail}</span></div>
    {elapsed && <time className="browser-control__elapsed" aria-live="off" title="当前操作已用时">{elapsed}</time>}
    <button type="button" className="browser-control__action" disabled={!replaying && (disabled || !connected)} onClick={replaying ? onReturnLive : onControl}>
      {replaying ? <ArrowLeft size={13} /> : control === 'pending' ? <X size={13} /> : control === 'user' ? <ArrowRight size={13} /> : <MousePointer2 size={13} />}
      {replaying ? '回到实时' : control === 'pending' ? '取消接管' : control === 'user' ? '交回 Trylo' : '我来接管'}
    </button>
  </section>
}
