import { useCallback, useEffect, useRef, useState } from 'react'
import { onComputerPreviewClosed, openComputerPreview } from '../host-adapter/computer-preview-window'
import type { ToolPreviewState } from './tool-preview-state'

/** Historical cards do not open windows; only a live invocation can open once per turn. */
export function useToolWorkbenchLifecycle(options: {
  readonly scope: string
  readonly running: boolean
  readonly autoOpenComputer?: boolean
  readonly browser: ToolPreviewState
  readonly computer: ToolPreviewState
  readonly showBrowser: () => void
  readonly onError: (message: string) => void
}) {
  const current = useRef(options)
  current.current = options
  const shown = useRef(new Set<string>())
  const openEpoch = useRef(0)
  const [observer, setObserver] = useState<{ scope: string; handle: number | null; request: number }>()
  const open = useCallback(async (automatic = false, prepare?: () => Promise<void>): Promise<void> => {
    const scope = current.current.scope
    const epoch = ++openEpoch.current
    try {
      if (prepare) await prepare()
      if (current.current.scope !== scope || openEpoch.current !== epoch) return
      const handle = await openComputerPreview(automatic)
      if (current.current.scope === scope && openEpoch.current === epoch) setObserver({ scope, handle, request: epoch })
    } catch (error) {
      if (current.current.scope === scope && openEpoch.current === epoch) current.current.onError(String(error))
    }
  }, [])
  useEffect(() => {
    let disposed = false
    let off: (() => void) | undefined
    void onComputerPreviewClosed(scope => {
      if (!disposed && (!scope || scope === current.current.scope)) { openEpoch.current++; setObserver(undefined) }
    }).then(unsubscribe => { if (disposed) unsubscribe(); else off = unsubscribe })
    return () => { disposed = true; off?.() }
  }, [])
  useEffect(() => {
    if (!options.running) return
    for (const kind of ['browser', 'computer'] as const) {
      if (kind === 'computer' && options.autoOpenComputer === false) continue
      const state = options[kind]
      if ((!state.active && !state.hasStarted) || !state.turnId) continue
      const key = `${options.scope}:${state.turnId}:${kind}`
      if (shown.current.has(key)) continue
      shown.current.add(key)
      if (shown.current.size > 128) { const oldest = shown.current.values().next().value; if (oldest) shown.current.delete(oldest) }
      if (kind === 'browser') current.current.showBrowser()
      else void open(true)
    }
  }, [options.scope, options.running, options.autoOpenComputer, options.browser.active, options.browser.hasStarted, options.browser.turnId,
    options.computer.active, options.computer.hasStarted, options.computer.turnId, open])
  useEffect(() => {
    setObserver(previous => previous?.scope === options.scope ? previous : undefined)
  }, [options.scope])
  return {
    openComputer: (prepare?: () => Promise<void>) => open(false, prepare),
    computerVisible: observer?.scope === options.scope,
    computerRequest: observer?.scope === options.scope ? observer.request : undefined,
    computerHandle: observer?.scope === options.scope ? observer.handle : null,
  }
}
