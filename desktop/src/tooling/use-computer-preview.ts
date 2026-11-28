import { useCallback, useEffect, useMemo, useRef } from 'react'
import { getToolResultStore } from './tool-result-store'
import type { PreviewFrameGeometry, ToolPreviewState } from './tool-preview-state'
import { isTauri } from '../host-adapter/tauri-detect'
import { publishComputerPreview, type ComputerPreviewSnapshot } from '../host-adapter/computer-preview-window'
import { createLatestPreviewPublisher } from './latest-preview-publisher'
import { useComputerStream, type ComputerStreamOptions } from './use-computer-stream'

interface Picture {
  readonly key: string
  readonly dataUrl: string
  readonly timestamp: number
  readonly geometry?: PreviewFrameGeometry
  readonly live: boolean
}

/** Live frames are transient UI data; only model tool screenshots use the disk cache. */
export function useComputerPreview(state: ToolPreviewState, scope: string, options: ComputerStreamOptions = {}): void {
  const current = useRef({ state, scope, options })
  current.current = { state, scope, options }
  const picture = useRef<Picture>()
  const stream = useRef<{ state: ComputerPreviewSnapshot['streamState']; detail?: string }>({ state: 'stopped' })
  const publisher = useMemo(() => createLatestPreviewPublisher(publishComputerPreview), [])
  useEffect(() => { publisher.resume(); return () => publisher.dispose() }, [publisher])
  const publish = useCallback((): Promise<boolean> => {
    if (!isTauri()) return Promise.resolve(false)
    const { state: latest, scope: latestScope } = current.current
    return publisher.publish({ title: latest.action?.title ?? latest.title, status: latest.action?.status ?? latest.status,
      detail: latest.detail, actions: latest.actions, action: latest.action, scope: latestScope,
      dataUrl: picture.current?.dataUrl, screenshotAt: latest.screenshotAt,
      frameGeometry: picture.current?.geometry, updatedAt: picture.current?.timestamp,
      streamState: stream.current.state, streamDetail: stream.current.detail })
  }, [publisher])

  useEffect(() => {
    picture.current = undefined
    stream.current = { state: options.enabled ? 'starting' : 'stopped' }
    publish()
  }, [scope, options.turnId, options.pickerRequest, options.enabled, publish])
  useEffect(() => {
    if (!options.enabled) { stream.current = { state: 'stopped' }; publish() }
  }, [options.enabled, publish])

  useComputerStream(options, {
    frame: frame => {
      picture.current = { key: `live:${frame.seq}`, dataUrl: `data:${frame.mimeType};base64,${frame.data}`,
        timestamp: frame.timestamp, live: true, geometry: { width: frame.width, height: frame.height,
          originX: frame.originX, originY: frame.originY, cursorX: frame.cursorX, cursorY: frame.cursorY } }
      stream.current.state = 'running'
      return publish().then(success => { if (!success) throw new Error('电脑小窗传输失败') })
    },
    status: status => {
      if (current.current.options.pickerRequest !== undefined && status.state !== 'running') picture.current = undefined
      stream.current = { state: status.state, detail: status.detail }
      publish()
    },
  })

  useEffect(() => {
    if (!isTauri()) return undefined
    let cancelled = false
    publish()
    const key = state.image ? `${scope}:${state.turnId ?? ''}:${state.image.sha256}` : ''
    if (!state.image || picture.current?.key === key || (picture.current?.live && options.enabled)) return undefined
    const load = async (): Promise<void> => {
      const ref = state.image
      if (!ref) return
      const bytes = await getToolResultStore().readBinaryBytes(ref)
      if (cancelled || !bytes) return
      const reader = new FileReader()
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () =>
          typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('截图读取失败'))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(new Blob([bytes as BlobPart], { type: ref.mimeType }))
      })
      if (cancelled || (picture.current?.live && current.current.options.enabled)) return
      picture.current = { key, dataUrl, timestamp: state.screenshotAt ?? state.updatedAt ?? 0, live: false }
      publish()
    }
    void load().catch(error => console.warn('电脑预览更新失败', error))
    return () => { cancelled = true }
  }, [scope, state.turnId, state.title, state.status, state.detail, state.image, state.screenshotAt,
    state.updatedAt, state.action?.id, state.action?.status, state.action?.target,
    state.action?.point?.x, state.action?.point?.y, options.enabled, publish])
}
