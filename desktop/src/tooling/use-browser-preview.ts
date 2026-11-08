// The live browser is a native view. Images are retained only as tool evidence.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ServiceManager } from '../services-host/service-manager'
import type { NativeBrowserState, ViewportActionEvent, ViewportFrameEvent, ViewportInputParams, ViewportStatusEvent } from '../services-host/methods'
import { nativeBrowserCommand, nativeBrowserScope, onNativeBrowserPage, onNativeBrowserControls, type NativeBrowserBounds, type NativeBrowserCommand, type NativeBrowserViewportRequest } from '../host-adapter/native-browser'
import type { ToolingFacade } from './tooling-facade'
import { createNativeLayoutQueue } from './native-browser-layout'

export type ViewportFrame = ViewportFrameEvent
export type ViewportStatus = ViewportStatusEvent['state']
export interface BrowserPreviewController {
  readonly scope?: string
  readonly status: ViewportStatus
  readonly detail: string
  readonly url: string
  readonly frameSeq: number
  readonly latestFrame: ViewportFrame | null
  readonly latestAction?: ViewportActionEvent
  readonly nativeState?: NativeBrowserState
  readonly zoom: number
  readonly start: () => Promise<void>
  readonly stop: () => Promise<void>
  readonly navigate: (url: string) => Promise<void>
  readonly navigation?: (operation: 'back' | 'forward' | 'reload') => Promise<void>
  readonly closeTab?: (label: string) => Promise<void>
  readonly input: (params: ViewportInputParams) => Promise<void>
  readonly setVisible: (visible: boolean) => void
  readonly setViewportSize: (size: { readonly width: number; readonly height: number }) => void
  readonly setBounds: (bounds: NativeBrowserBounds, visible: boolean) => Promise<void>
  readonly setZoom: (zoom: number) => Promise<void>
  readonly setPageViewport?: (viewport: NativeBrowserViewportRequest) => Promise<void>
  readonly takeControl: () => Promise<void>
  readonly releaseControl: () => Promise<void>
  readonly selectTab: (label: string) => Promise<void>
  readonly createTab: () => Promise<void>
}
export function useBrowserPreview(options: {
  readonly facade: ToolingFacade | null
  readonly serviceManager: ServiceManager | null
  readonly projectRoot?: string
  readonly conversationId?: string | null
  readonly initiallyVisible?: boolean
}): BrowserPreviewController {
  const { facade, serviceManager } = options
  // Needed even with a closed sidebar: Code/Work profile resolution asks
  // Desktop to create the native browser before advertising its MCP tools.
  useEffect(() => facade?.connectNativeBridge(), [facade])
  const scope = useMemo(() => options.conversationId ? nativeBrowserScope(options.projectRoot ?? '', options.conversationId) : '', [options.projectRoot, options.conversationId])
  const scopeRef = useRef(scope); scopeRef.current = scope
  const [snapshot, setSnapshot] = useState<NativeBrowserState>()
  const [status, setStatus] = useState<ViewportStatus>('stopped')
  const [detail, setDetail] = useState('')
  const [visible, setVisible] = useState(options.initiallyVisible ?? true)
  const [ready, setReady] = useState(serviceManager?.currentHealth === 'ready')
  const [zoom, setZoomValue] = useState(1)
  const boundsRef = useRef<NativeBrowserBounds>()
  const visibleRef = useRef(visible); visibleRef.current = visible
  const generation = useRef(0)
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot
  const facadeRef = useRef(facade); facadeRef.current = facade
  const applyRef = useRef<(state: NativeBrowserState) => void>(() => {})
  const nativeFirst = useRef(false)
  const failRef = useRef<(error: unknown) => void>(() => {})
  const viewportQueue = useRef<ReturnType<typeof createNativeLayoutQueue>>()
  const layoutQueue = useRef<ReturnType<typeof createNativeLayoutQueue>>()
  if (!viewportQueue.current) viewportQueue.current = createNativeLayoutQueue(async command => {
    const host = facadeRef.current
    if (!host) return
    const epoch = generation.current
    const state = await host.nativeBrowserLayout(command.scope, command.bounds, command.visible === true, true)
    if (generation.current === epoch) applyRef.current(state)
  }, requested => requested === scopeRef.current && visibleRef.current)
  if (!layoutQueue.current) layoutQueue.current = createNativeLayoutQueue(async command => {
    if (!facadeRef.current && command.visible) throw new Error('浏览器服务尚未连接')
    // Window geometry must not wait behind CDP measurement or an agent command.
    // The host is notified afterward and must never replay these old bounds.
    const host = facadeRef.current
    const epoch = generation.current
    if (host && !nativeFirst.current) {
      const state = await host.nativeBrowserLayout(command.scope, command.bounds, command.visible === true)
      if (generation.current === epoch) applyRef.current(state)
      return
    }
    await nativeBrowserCommand(command)
    void viewportQueue.current!(command).catch(error => {
      if (generation.current === epoch && command.scope === scopeRef.current) failRef.current(error)
    })
  }, requested => requested === scopeRef.current && visibleRef.current)
  const layout = useCallback((command: NativeBrowserCommand) => layoutQueue.current!(command), [])
  const apply = useCallback((state: NativeBrowserState): void => {
    if (state.scope !== scopeRef.current) return
    const previous = snapshotRef.current
    if (previous?.scope === state.scope && previous.revision !== undefined && state.revision !== undefined && state.revision < previous.revision) return
    nativeFirst.current = state.nativeLayout === 'direct'
    snapshotRef.current = state
    setSnapshot(state); setStatus(state.state); setDetail(state.detail)
  }, [])
  applyRef.current = apply
  const fail = useCallback((error: unknown): void => {
    setStatus('error'); setDetail(error instanceof Error ? error.message : String(error))
  }, [])
  failRef.current = fail
  // User actions share the same host-generation boundary as native events.
  const atCurrentHost = useCallback(async (requested: string, operation: (current: () => boolean) => Promise<void>): Promise<void> => {
    const epoch = generation.current
    const current = (): boolean => requested === scopeRef.current && generation.current === epoch
    try { await operation(current) }
    catch (error) { if (current()) throw error }
  }, [])
  useEffect(() => {
    setReady(serviceManager?.currentHealth === 'ready')
    return serviceManager?.onHealth(health => {
      if (health !== 'ready') {
        // A previous host cannot settle the replacement host's startup.
        // Its late response/timeout still carries the same conversation.
        generation.current++
        nativeFirst.current = false
        snapshotRef.current = undefined; setSnapshot(undefined)
        setStatus('error'); setDetail('浏览器服务已断开')
      }
      setReady(health === 'ready')
    })
  }, [serviceManager])
  useEffect(() => {
    const off = serviceManager?.client.onEvent('tooling.nativeBrowserState', apply)
    let disposed = false, offPage = (): void => {}
    void onNativeBrowserPage(event => {
      if (event.scope !== scopeRef.current || !facade || snapshotRef.current?.scope !== event.scope) return
      // A replacement host reuses the scope but starts a new revision sequence.
      const epoch = generation.current
      const current = (): boolean => !disposed && event.scope === scopeRef.current && generation.current === epoch
      void facade.nativeBrowserState(event.scope).then(state => { if (current()) apply(state) })
        .catch(error => { if (current()) fail(error) })
    }).then(unsubscribe => { if (disposed) unsubscribe(); else offPage = unsubscribe }).catch(fail)
    return () => { disposed = true; off?.(); offPage() }
  }, [serviceManager, facade, apply, fail])
  useEffect(() => {
    let disposed = false, off = (): void => {}
    void onNativeBrowserControls(event => {
      if (event.scope !== scopeRef.current) return
      if (event.error) setDetail(event.error)
      if (event.label && event.label !== snapshotRef.current?.activeLabel) return
      if (event.zoom && Number.isFinite(event.zoom)) {
        const epoch = generation.current
        const current = (): boolean => !disposed && scopeRef.current === event.scope && generation.current === epoch
        const applied = (state: NativeBrowserState | undefined): void => { if (state && current()) apply(state) }
        const failed = (error: unknown): void => { if (current()) fail(error) }
        const fixed = snapshotRef.current?.viewport
        if (fixed?.mode === 'fixed' && facadeRef.current && event.zoom !== 1) {
          const label = snapshotRef.current!.activeLabel, host = facadeRef.current
          void nativeBrowserCommand({ scope: event.scope, operation: 'zoom', zoom: 1 })
            .then(() => current() ? host.nativeBrowserViewport(event.scope, label, fixed) : undefined).then(applied).catch(failed)
        } else {
          setZoomValue(event.zoom)
          // Native keyboard zoom is also reflected in the host's geometry.
          if (facadeRef.current) {
            const host = facadeRef.current
            void nativeBrowserCommand({ scope: event.scope, operation: 'zoom', zoom: event.zoom })
              .then(() => current() ? host.nativeBrowserState(event.scope) : undefined).then(applied).catch(failed)
          }
        }
      }
      if (event.key === 'Escape') window.dispatchEvent(new Event('trylo:exit-browser-fullscreen'))
    }).then(unsubscribe => { if (disposed) unsubscribe(); else off = unsubscribe }).catch(fail)
    return () => { disposed = true; off() }
  }, [apply, fail])
  const start = useCallback(async (): Promise<void> => {
    if (!facade || !options.conversationId || !ready) return
    const requested = scope, epoch = generation.current
    setStatus('starting'); setDetail('')
    try {
      const state = await facade.nativeBrowserOpen({ projectRoot: options.projectRoot ?? '', conversationId: options.conversationId })
      if (scopeRef.current !== requested || generation.current !== epoch) return
      apply(state)
      if (boundsRef.current) await layout({ scope: requested, operation: 'layout', bounds: boundsRef.current, visible: visibleRef.current })
    } catch (error) { if (scopeRef.current === requested && generation.current === epoch) fail(error) }
  }, [facade, options.projectRoot, options.conversationId, ready, scope, apply, fail, layout])
  useEffect(() => {
    generation.current++
    snapshotRef.current = undefined; setSnapshot(undefined); setStatus('stopped'); setDetail(''); setZoomValue(1)
    return () => { if (scope) void layout({ scope, operation: 'layout', visible: false }).catch(() => {}) }
  }, [scope, layout])
  useEffect(() => { if (visible && ready && scope) void start() }, [visible, ready, scope, start])
  useEffect(() => {
    if (!scope) return
    if (!visible) void layout({ scope, operation: 'layout', visible: false }).catch(() => {})
  }, [visible, scope, layout])
  const setBounds = useCallback(async (bounds: NativeBrowserBounds, show: boolean): Promise<void> => {
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 1 || bounds.height < 1) return
    boundsRef.current = bounds
    if (!scope) return
    if (snapshotRef.current?.scope !== scope) return
    await layout({ scope, operation: 'layout', bounds, visible: show && visibleRef.current })
  }, [scope, layout])
  const stop = useCallback(async (): Promise<void> => {
    setVisible(false)
    if (scope) await layout({ scope, operation: 'layout', visible: false })
  }, [scope, layout])
  const navigate = useCallback(async (url: string): Promise<void> => {
    await nativeBrowserCommand({ scope, operation: 'navigate', url })
  }, [scope])
  const navigation = useCallback(async (operation: 'back' | 'forward' | 'reload'): Promise<void> => {
    await nativeBrowserCommand({ scope, operation })
  }, [scope])
  const closeTab = useCallback(async (label: string): Promise<void> => {
    if (!facade) throw new Error('浏览器服务尚未连接')
    await atCurrentHost(scope, async current => {
      await nativeBrowserCommand({ scope, operation: 'close', label })
      if (!current()) return
      const state = await facade.nativeBrowserState(scope)
      if (current()) apply(state)
    })
  }, [scope, facade, apply, atCurrentHost])
  const setZoom = useCallback(async (value: number): Promise<void> => {
    if (snapshotRef.current?.viewport?.mode === 'fixed') throw new Error('固定页面尺寸使用适应展示比例')
    await atCurrentHost(scope, async current => {
      await nativeBrowserCommand({ scope, operation: 'zoom', zoom: value })
      if (!current()) return
      setZoomValue(value)
      if (facade) {
        const state = await facade.nativeBrowserState(scope)
        if (current()) apply(state)
      }
    })
  }, [scope, facade, apply, atCurrentHost])
  const setPageViewport = useCallback(async (viewport: NativeBrowserViewportRequest): Promise<void> => {
    if (!facade || !scope || !snapshotRef.current) throw new Error('浏览器尚未连接')
    const epoch = generation.current, label = snapshotRef.current.activeLabel
    const state = await facade.nativeBrowserViewport(scope, label, viewport)
    if (scopeRef.current !== scope || generation.current !== epoch) return
    apply(state)
    if (state.viewport?.mode === 'fixed') setZoomValue(1)
  }, [scope, facade, apply])
  const takeControl = useCallback(async (): Promise<void> => {
    if (!facade || !scope) throw new Error('浏览器尚未连接')
    await atCurrentHost(scope, async current => {
      const state = await facade.nativeBrowserControl(scope, true)
      if (!current()) return
      apply(state)
      await nativeBrowserCommand({ scope, operation: 'focus' })
    })
  }, [facade, scope, apply, atCurrentHost])
  const releaseControl = useCallback(async (): Promise<void> => {
    if (!facade || !scope) throw new Error('浏览器尚未连接')
    await atCurrentHost(scope, async current => {
      const state = await facade.nativeBrowserControl(scope, false)
      if (current()) apply(state)
    })
  }, [facade, scope, apply, atCurrentHost])
  const selectTab = useCallback(async (label: string): Promise<void> => {
    if (!facade) throw new Error('浏览器服务尚未连接')
    await atCurrentHost(scope, async current => {
      const state = await facade.nativeBrowserSelect(scope, label)
      if (current()) apply(state)
    })
  }, [facade, scope, apply, atCurrentHost])
  const createTab = useCallback(async (): Promise<void> => {
    if (!facade) throw new Error('浏览器服务尚未连接')
    await atCurrentHost(scope, async current => {
      const state = await facade.nativeBrowserCreate(scope)
      if (current()) apply(state)
    })
  }, [facade, scope, apply, atCurrentHost])
  const input = useCallback(async (_params: ViewportInputParams): Promise<void> => {
    throw new Error('原生浏览器直接接收输入')
  }, [])
  const setViewportSize = useCallback((size: { width: number; height: number }): void => {
    const previous = boundsRef.current
    const requested = scopeRef.current, epoch = generation.current
    if (previous) void setBounds({ ...previous, ...size }, visibleRef.current).catch(error => {
      if (requested === scopeRef.current && generation.current === epoch) fail(error)
    })
  }, [setBounds, fail])
  return { scope, status, detail, url: snapshot?.tabs.find(tab => tab.label === snapshot.activeLabel)?.url ?? '',
    nativeState: snapshot, zoom, latestFrame: null, frameSeq: 0, start, stop, navigate, input,
    setVisible, setViewportSize, setBounds, setZoom, setPageViewport, takeControl, releaseControl, selectTab, createTab, navigation, closeTab }
}
