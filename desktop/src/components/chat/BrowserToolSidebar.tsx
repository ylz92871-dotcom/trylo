import { BrowserNavigationError } from './BrowserNavigationError'
import { useNativeBrowserBounds } from './use-native-browser-bounds'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Globe, X, RotateCw, Maximize2, Minimize2, ArrowLeft, ArrowRight, Plus, LoaderCircle, Check, Copy, SlidersHorizontal } from 'lucide-react'
import { PreviewImage } from './PreviewImage'
import { PreviewZoom } from './PreviewZoom'
import { BrowserActivity } from './BrowserActivity'
import { BrowserControlNotice } from './BrowserControlNotice'
import { browserActivityView } from './browser-activity-state'
export { browserSidebarPhase } from './browser-activity-state'
import { BrowserViewportControls } from './BrowserViewportControls'
import type { BrowserPreviewController } from '../../tooling/use-browser-preview'
import type { PreviewAction, ToolPreviewState } from '../../tooling/tool-preview-state'
import { type BrowserReplay, type BrowserReplayEntry } from '../../tooling/use-browser-replay'

function tabTitle(title: string, url: string): string {
  if (!url || url.startsWith('about:blank')) return '新标签页'
  return title && !title.startsWith('about:blank') ? title : siteLabel(url)
}
function siteLabel(raw: string): string {
  if (!raw || raw.startsWith('about:blank')) return '浏览器'
  try { return new URL(raw).host || raw } catch { return raw }
}
export function BrowserToolSidebar(props: {
  readonly state: ToolPreviewState
  readonly preview?: BrowserPreviewController
  readonly replay?: BrowserReplay
  readonly width: number
  readonly running?: boolean
  readonly fullscreen?: boolean
  readonly suspended?: boolean
  readonly onToggleFullscreen?: () => void
  readonly onClose: () => void
}): ReactElement {
  const { preview } = props
  const native = preview?.nativeState
  const nativeScope = native?.scope
  const pictureRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const [displayOpen, setDisplayOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [addressDraft, setAddressDraft] = useState<string>()
  const copyTimer = useRef<ReturnType<typeof setTimeout>>()
  const mounted = useRef(true)
  const owner = JSON.stringify([preview?.scope, props.state.turnId])
  const [selected, setSelected] = useState<{ owner: string; action: PreviewAction; entry: BrowserReplayEntry }>()
  const replay = selected?.owner === owner ? selected : undefined
  const replaying = !!replay
  const activity = browserActivityView(props.state, preview, props.running ?? props.state.active === true, replay?.action)
  const phase = activity.phase
  const history = props.state.actions ?? []
  const rawAddress = replay ? replay.entry.url ?? '' : preview?.url || props.state.url || ''
  const address = rawAddress.startsWith('about:blank') ? '' : rawAddress
  const activeTab = native?.tabs.find(tab => tab.label === native.activeLabel)
  const blank = !replaying && (!rawAddress || rawAddress.startsWith('about:blank'))
  const popup = activeTab?.popup === true
  const navigationError = !replaying ? activeTab?.navigationError : undefined
  useEffect(() => { setAddressDraft(undefined) }, [preview?.scope, native?.activeLabel])
  const failure = [...history].reverse().find(action => action.status === '失败')
  const reason = failure?.error || (props.state.action?.status === '失败' ? props.state.detail : '')
  const displayReason = navigationError ? '' : reason && reason !== '工具返回截图后会显示在这里。' ? reason : phase === 'failed' ? !failure && props.state.action?.status !== '失败' ? '较早的操作失败，详情可在对话中查看。' : '工具未返回失败原因。' : ''
  const connected = preview?.status === 'running' && !!native
  const navigateAddress = async (): Promise<void> => {
    const raw = (addressDraft ?? address).trim()
    if (!raw || !preview) return
    const explicit = raw.includes('://') || /^(about|file|data):/i.test(raw)
    const local = /^(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(raw)
    const url = explicit ? raw : `${local ? 'http' : 'https'}://${raw}`
    await preview.navigate(url); setAddressDraft(undefined)
  }
  const setBounds = preview?.setBounds
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; clearTimeout(copyTimer.current) }
  }, [])
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setError('')
    try { await operation() } catch (value) { if (mounted.current) setError(value instanceof Error ? value.message : String(value)) }
  }
  useNativeBrowserBounds({
    element: pictureRef, scope: nativeScope, tab: native?.activeLabel, setBounds,
    visible: connected && !replaying && !props.suspended && !blank && !popup && !navigationError,
    onError: value => setError(value instanceof Error ? value.message : String(value)),
  })
  useEffect(() => {
    const box = pictureRef.current
    return () => {
      const rect = box?.getBoundingClientRect()
      if (rect && setBounds) void setBounds({ x: rect.left, y: rect.top, width: Math.max(1, rect.width), height: Math.max(1, rect.height) }, false).catch(() => {})
    }
  }, [setBounds])
  const showReplay = (action: PreviewAction): void => {
    const entry = props.replay?.[action.id]
    if (entry) setSelected({ owner, action, entry })
  }
  const copyAddress = async (): Promise<void> => {
    await navigator.clipboard.writeText(address)
    if (!mounted.current) return
    setCopied(true); clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1600)
  }
  const preparingPage = connected && blank && (activity.mode === 'acting' || activity.mode === 'queued' || activity.mode === 'pending-control')
  const empty = phase === 'connecting' ? '正在连接浏览器' : phase === 'disconnected' ? '浏览器连接已断开' : preparingPage ? '正在准备网页' : '打开一个网页'
  const focusAddress = (): void => { addressRef.current?.focus(); addressRef.current?.select() }
  return <aside className="browser-tool-sidebar" data-phase={phase} data-fullscreen={props.fullscreen || undefined} style={{ width: props.fullscreen ? undefined : props.width }} aria-label="浏览器侧栏">
    <header className="browser-tool-sidebar__head">
      <div className="browser-tool-sidebar__site-row">
        <Globe size={15} aria-hidden="true" />
        <span className="browser-tool-sidebar__site" title={address || undefined}>浏览器</span>
        {address && <button type="button" className="browser-tool-sidebar__icon-button" aria-label={copied ? '网址已复制' : '复制网页地址'} title={copied ? '已复制' : '复制网址'} onClick={() => void run(copyAddress)}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>}
        {preview && !connected && <button type="button" className="browser-tool-sidebar__icon-button" aria-label="重新连接浏览器" title="重新连接" onClick={() => void run(preview.start)}><RotateCw size={14} /></button>}
        {!replaying && preview && native && <button type="button" className="browser-tool-sidebar__icon-button" aria-label="页面显示设置" title="页面显示设置" aria-expanded={displayOpen} aria-controls="browser-display-settings" onClick={() => setDisplayOpen(value => !value)}><SlidersHorizontal size={15} /></button>}
        {props.onToggleFullscreen && <button type="button" className="browser-tool-sidebar__icon-button" title={props.fullscreen ? '退出全屏' : '全屏'} aria-label={props.fullscreen ? '退出浏览器全屏' : '浏览器全屏'} aria-pressed={props.fullscreen ?? false} onClick={props.onToggleFullscreen}>{props.fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
        <button type="button" className="browser-tool-sidebar__icon-button" title="收起浏览器" aria-label="收起浏览器侧栏" onClick={props.onClose}><X size={16} /></button>
      </div>
    </header>
    {!replaying && native && <div className="browser-tool-sidebar__tabs" role="tablist" aria-label="浏览器标签页" onKeyDown={event => {
      if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      const index = tabs.indexOf(event.target as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      event.preventDefault(); tabs[next]?.focus(); tabs[next]?.click()
    }}>
      {native.tabs.map(tab => <div className="browser-tool-sidebar__tab" data-selected={tab.label === native.activeLabel || undefined} key={tab.id}>
        <button type="button" role="tab" tabIndex={tab.label === native.activeLabel ? 0 : -1} aria-selected={tab.label === native.activeLabel} title={tab.url.startsWith('about:blank') ? '新标签页' : tab.url} onClick={() => void run(() => preview!.selectTab(tab.label))}><Globe size={12} aria-hidden="true" /><span>{tabTitle(tab.title, tab.url)}</span></button>
        {preview?.closeTab && <button type="button" className="browser-tool-sidebar__close-tab" aria-label={`关闭标签页：${tabTitle(tab.title, tab.url)}`} onClick={() => void run(() => preview.closeTab!(tab.label))}><X size={11} /></button>}
      </div>)}
      <button type="button" className="browser-tool-sidebar__new-tab" aria-label="新建浏览器标签页" title="新建标签页" onClick={() => void run(preview!.createTab)}><Plus size={15} /></button>
    </div>}
    {!replaying && preview && <form className="browser-tool-sidebar__address" onSubmit={event => { event.preventDefault(); void run(navigateAddress) }}>
      <button type="button" className="browser-tool-sidebar__icon-button" aria-label="网页后退" title="后退" disabled={!connected || !preview.navigation} onClick={() => void run(() => preview.navigation!('back'))}><ArrowLeft size={14} /></button>
      <button type="button" className="browser-tool-sidebar__icon-button" aria-label="网页前进" title="前进" disabled={!connected || !preview.navigation} onClick={() => void run(() => preview.navigation!('forward'))}><ArrowRight size={14} /></button>
      <button type="button" className="browser-tool-sidebar__icon-button" aria-label="刷新网页" title="刷新" disabled={!connected || !preview.navigation} onClick={() => void run(() => preview.navigation!('reload'))}><RotateCw size={14} /></button>
      <div className="browser-tool-sidebar__address-field"><input ref={addressRef} aria-label="网页地址" type="text" spellCheck={false} autoComplete="off" placeholder="输入网址，按 Enter 打开" value={addressDraft ?? address} disabled={!connected} onFocus={event => event.currentTarget.select()} onChange={event => setAddressDraft(event.target.value)} onBlur={() => setAddressDraft(undefined)} onKeyDown={event => { if (event.key === 'Escape') { setAddressDraft(undefined); event.currentTarget.blur() } }} /></div>
    </form>}
    {!replaying && displayOpen && preview && native && <div id="browser-display-settings" className="browser-tool-sidebar__display-settings" aria-label="页面显示设置">
      {native.cdpAvailable !== false && <BrowserViewportControls key={`${native.scope}:${native.activeLabel}`} viewport={native.viewport} disabled={!connected || native.inFlight > 0 || !preview.setPageViewport} onChange={request => preview.setPageViewport!(request)} />}
      <div className="browser-tool-sidebar__zoom-row"><span>网页缩放</span>{native.viewport?.mode === 'fixed' ? <span className="browser-viewport-controls__scale">适应展示 · 页面 100%</span> : <div className="browser-tool-sidebar__zoom"><PreviewZoom value={preview.zoom} onChange={value => { if (value !== 'fit') void run(() => preview.setZoom(value)) }} showFit={false} disabled={!connected} label="网页缩放" /></div>}</div>
    </div>}
    <div className="browser-control-frame" data-state={activity.mode}>
      {(replaying || native?.cdpAvailable !== false) && <BrowserControlNotice view={activity} control={native?.control} connected={connected} disabled={blank || popup || !!navigationError} running={props.running === true}
        onControl={() => void run(native?.control === 'agent' ? preview!.takeControl : preview!.releaseControl)} onReturnLive={() => setSelected(undefined)} />}
      <div className="browser-control-frame__edge" data-state={activity.mode}>
    <div className="browser-tool-sidebar__picture" ref={pictureRef} data-native={!replaying && !navigationError || undefined}>
      {navigationError ? <BrowserNavigationError failure={navigationError} onRetry={() => void run(() => preview!.navigation!('reload'))} onEdit={focusAddress} /> : replay ? <PreviewImage src={replay.entry.src} alt={`第 ${replay.action.stepIndex ?? ''} 项操作的历史画面`} empty="历史画面不可用" frameGeometry={replay.entry.geometry} />
        : !connected || blank || popup ? <div className="browser-tool-sidebar__empty">
          {phase === 'connecting' ? <LoaderCircle className="browser-tool-sidebar__empty-spinner" size={25} strokeWidth={1.4} /> : <Globe size={27} strokeWidth={1.2} />}
          <strong>{popup ? '页面已在独立窗口中打开' : empty}</strong>
          <span>{popup ? '切回该窗口继续操作，或选择其他标签页。' : preparingPage ? '网页打开后会显示在这里。' : connected ? native?.cdpAvailable === false ? '输入网址以打开网页。' : '输入网址，或让智能体开始浏览。' : phase === 'connecting' ? '页面将在连接完成后显示。' : '连接后可以在这里浏览和检查网页。'}</span>
          {!popup && !preparingPage && phase !== 'connecting' && (connected ? <button type="button" onClick={focusAddress}>输入网址<ArrowRight size={13} /></button> : preview && <button type="button" onClick={() => void run(preview.start)}>连接浏览器<ArrowRight size={13} /></button>)}
        </div> : null}
    </div>
      </div>
    </div>
    <BrowserActivity view={activity} state={props.state} historyOpen={historyOpen} onHistoryToggle={() => setHistoryOpen(value => !value)}
      replay={props.replay} replaying={replaying} onReplay={showReplay} errors={[displayReason, preview?.detail ?? '', error]} />
  </aside>
}
