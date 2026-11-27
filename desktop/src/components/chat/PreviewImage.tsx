import { useEffect, useRef, useState, type ReactElement, type PointerEvent } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { PreviewZoom } from './PreviewZoom'
import type { ViewportInputParams } from '../../services-host/methods'
import type { PreviewAction, PreviewFrameGeometry } from '../../tooling/tool-preview-state'

function relativePoint(x: number, y: number, space: 'screen' | 'normalized' | 'viewport', geometry: PreviewFrameGeometry | undefined, size: { width: number; height: number }): { x: number; y: number } | null {
  const width = geometry?.width ?? size.width
  const height = geometry?.height ?? size.height
  if (width <= 0 || height <= 0 || (space === 'screen' && !geometry)) return null
  const point = space === 'normalized' ? { x, y } : {
    x: (x - (space === 'screen' ? geometry?.originX ?? 0 : 0)) / width,
    y: (y - (space === 'screen' ? geometry?.originY ?? 0 : 0)) / height,
  }
  return Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 ? point : null
}

export function PreviewImage({
  src,
  alt,
  empty,
  emptyDescription = '工具开始后自动显示操作画面',
  toolbarPosition = 'top',
  renderToolbar,
  onInput,
  action,
  frameGeometry,
}: {
  readonly src?: string
  readonly alt: string
  readonly empty: string
  readonly emptyDescription?: string
  readonly toolbarPosition?: 'top' | 'bottom'
  readonly renderToolbar?: (toolbar: ReactElement) => ReactElement
  readonly onInput?: (params: ViewportInputParams) => Promise<void>
  readonly action?: PreviewAction
  readonly frameGeometry?: PreviewFrameGeometry
}): ReactElement {
  const [zoom, setZoom] = useState<'fit' | 1 | 2>('fit')
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const [showAction, setShowAction] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!action?.point || (action.status !== '执行中' && action.status !== '已完成')) {
      setShowAction(false)
      return
    }
    if (action.status === '执行中') {
      setShowAction(true)
      return
    }
    const anchor = action.completedAt ?? action.startedAt ?? Date.now()
    const remaining = Math.max(0, 3200 - (Date.now() - anchor))
    setShowAction(remaining > 0)
    if (!remaining) return
    const timeout = window.setTimeout(() => setShowAction(false), remaining)
    return () => window.clearTimeout(timeout)
  }, [action?.id, action?.status, action?.startedAt, action?.completedAt, action?.point])
  const scale = window.devicePixelRatio || 1
  const fit = size.width > 0 && size.height > 0 ? Math.min(viewportSize.width / size.width, viewportSize.height / size.height) : 0
  const imageScale = zoom === 'fit' ? fit : zoom / scale
  const imageWidth = size.width * imageScale
  const imageHeight = size.height * imageScale
  const point = action?.point && showAction ? relativePoint(action.point.x, action.point.y, action.point.space, frameGeometry, size) : null
  const end = action?.point?.endX !== undefined && action.point.endY !== undefined && showAction ? relativePoint(action.point.endX, action.point.endY, action.point.space, frameGeometry, size) : null
  const cursor = frameGeometry?.cursorX !== undefined && frameGeometry.cursorY !== undefined ? relativePoint(frameGeometry.cursorX, frameGeometry.cursorY, 'screen', frameGeometry, size) : null
  const pointer = (event: PointerEvent<HTMLImageElement>, inputAction: 'pressed' | 'released' | 'moved'): void => {
    if (!onInput || (inputAction === 'moved' && !event.buttons)) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (inputAction === 'pressed') { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId) }
    void onInput({ kind: 'mouse', action: inputAction, x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)), button: event.button === 2 ? 'right' : 'left' })
  }
  const toolbar = (
    <div className="preview-image__toolbar">
      <span>{src && size.width ? `${size.width} × ${size.height}` : '原始画面'}</span>
      <PreviewZoom value={zoom} onChange={setZoom} />
    </div>
  )
  const toolbarContent = renderToolbar ? renderToolbar(toolbar) : toolbar
  return (
    <div className="preview-image">
      {toolbarPosition === 'top' && toolbarContent}
      <div ref={viewportRef} className={`preview-image__viewport${zoom === 'fit' ? ' preview-image__viewport--fit' : ''}`}>
        {src ? <div className="preview-image__stage" style={size.width ? { width: imageWidth, height: imageHeight } : undefined}>
          <img src={src} alt={alt} draggable={false} tabIndex={onInput ? 0 : undefined}
            onPointerDown={event => pointer(event, 'pressed')} onPointerUp={event => pointer(event, 'released')} onPointerMove={event => pointer(event, 'moved')}
            onKeyDown={event => { if (onInput && event.key.length === 1) { event.preventDefault(); void onInput({ kind: 'key', text: event.key }) } }}
            onWheel={event => {
              if (!onInput || zoom !== 'fit') return
              const rect = event.currentTarget.getBoundingClientRect()
              void onInput({ kind: 'wheel', x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height, deltaY: event.deltaY / 100 })
            }}
            onLoad={event => {
              const width = event.currentTarget.naturalWidth, height = event.currentTarget.naturalHeight
              setSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
            }} />
          {end && point && <svg className="preview-image__drag" aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none"><line x1={point.x * 100} y1={point.y * 100} x2={end.x * 100} y2={end.y * 100} /></svg>}
          {cursor && <span className="preview-image__cursor" aria-label="电脑指针位置" style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }}><svg width="17" height="21" viewBox="0 0 17 21" aria-hidden="true"><path d="M2 1v16l4-4 3 6 3-1-3-6h6Z" /></svg></span>}
          {point && !cursor && (
            <span className="preview-image__agent-cursor" aria-label="代理虚拟光标" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}>
              <svg width="17" height="21" viewBox="0 0 17 21" aria-hidden="true"><path d="M2 1v16l4-4 3 6 3-1-3-6h6Z" /></svg>
            </span>
          )}
          {point && <span key={`${action?.id}-${action?.startedAt}`} className="preview-image__target" title={action?.target || action?.title} data-click={action?.title.includes('点击') || action?.title.includes('后台操作控件') || action?.title.includes('后台写入控件')} aria-label={action?.point?.space === 'screen' ? '操作目标位置' : action?.title.includes('点击') ? '点击位置' : '操作位置'} style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} />}
        </div> : <div className="preview-image__empty"><ImageIcon size={28} strokeWidth={1} /><strong>{empty}</strong><p>{emptyDescription}</p></div>}
      </div>
      {toolbarPosition === 'bottom' && toolbarContent}
    </div>
  )
}
