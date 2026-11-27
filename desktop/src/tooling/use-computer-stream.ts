import { useEffect, useRef, useState } from 'react'
import type { ServiceManager } from '../services-host/service-manager'
import type { ComputerPreviewFrameEvent, ComputerPreviewStatusEvent } from '../services-host/methods'
import type { ToolingFacade } from './tooling-facade'

export interface ComputerStreamOptions {
  readonly manager?: ServiceManager | null
  readonly facade?: ToolingFacade | null
  readonly projectRoot?: string
  readonly conversationId?: string | null
  readonly enabled?: boolean
  readonly excludeWindow?: number | null
  readonly turnId?: string
  readonly display?: number
  readonly pickerRequest?: number
}

let streamSequence = 0
export function useComputerStream(options: ComputerStreamOptions, callbacks: {
  readonly frame: (frame: ComputerPreviewFrameEvent) => void | Promise<void>
  readonly status: (status: ComputerPreviewStatusEvent) => void
}): void {
  const current = useRef(callbacks)
  current.current = callbacks
  const [ready, setReady] = useState(options.manager?.currentHealth === 'ready')
  const attemptedPicker = useRef<number>()
  const key = JSON.stringify([options.projectRoot, options.conversationId, options.turnId, options.enabled,
    options.excludeWindow, options.display, options.pickerRequest, ready])
  const desired = useRef({ key, manager: options.manager, facade: options.facade })
  desired.current = { key, manager: options.manager, facade: options.facade }
  useEffect(() => {
    setReady(options.manager?.currentHealth === 'ready')
    return options.manager?.onHealth(health => setReady(health === 'ready'))
  }, [options.manager])
  useEffect(() => {
    const { manager, facade, projectRoot, conversationId } = options
    if (!projectRoot || !conversationId || !options.enabled) return undefined
    const scope = JSON.stringify([projectRoot.replaceAll('\\', '/').toLowerCase().replace(/\/$/, ''), conversationId])
    if (!manager || !facade || !ready) {
      current.current.status({ scope, streamId: '', state: 'starting', detail: '等待预览服务就绪' })
      return undefined
    }
    if (options.pickerRequest !== undefined) {
      if (attemptedPicker.current === options.pickerRequest) {
        current.current.status({ scope, streamId: '', state: 'stopped', detail: '请重新选择要预览的窗口' })
        return undefined
      }
      attemptedPicker.current = options.pickerRequest
    }
    const streamId = `${scope}:${options.turnId ?? ''}:${++streamSequence}`
    let cancelled = false
    let ended = false
    let seq = -1
    const isCurrent = (): boolean => !cancelled && desired.current.key === key && desired.current.manager === manager && desired.current.facade === facade
    const status = (event: ComputerPreviewStatusEvent): void => {
      if (isCurrent() && event.scope === scope && event.streamId === streamId) {
        if (event.state === 'error' || event.state === 'stopped') ended = true
        current.current.status(event)
      }
    }
    status({ scope, streamId, state: 'starting', detail: '正在连接电脑画面' })
    const offFrame = manager.client.onEvent('tooling.computerPreviewFrame', frame => {
      if (!isCurrent() || ended || frame.scope !== scope || frame.streamId !== streamId || frame.seq <= seq) return
      seq = frame.seq
      Promise.resolve(current.current.frame(frame)).then(() => {
        if (isCurrent() && !ended) return facade.computerPreviewAck({ scope, streamId, seq: frame.seq })
        return undefined
      }).catch(error => {
        if (!isCurrent()) return
        status({ scope, streamId, state: 'error', detail: String(error) })
        cancelled = true
        offFrame()
        offStatus()
        void facade.computerPreviewStop({ scope, streamId }).catch(() => {})
      })
    })
    const offStatus = manager.client.onEvent('tooling.computerPreviewStatus', status)
    void facade.computerPreviewStart({ projectRoot, conversationId, streamId, display: options.display,
      excludeWindow: options.excludeWindow ?? undefined }).then(result => {
      if (!result.ok) status({ scope, streamId, state: 'error', detail: result.error ?? '电脑画面连接失败' })
      if (cancelled) void facade.computerPreviewStop({ scope, streamId }).catch(() => {})
    }).catch(error => status({ scope, streamId, state: 'error', detail: String(error) }))
    return () => {
      cancelled = true
      offFrame()
      offStatus()
      void facade.computerPreviewStop({ scope, streamId }).catch(() => {})
    }
  }, [options.manager, options.facade, options.projectRoot, options.conversationId, options.enabled,
    options.excludeWindow, options.turnId, options.display, options.pickerRequest, ready, key])
}
