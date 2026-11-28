import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Image as ImageIcon, X } from 'lucide-react'
import type { ToolMessage } from './types'
import type { BinaryRef, ToolResultContent } from '../../tooling/tool-result-content'
import { useGeneratedMediaUrl } from '../../tooling/use-generated-media-url'
import { animateCollapseToSource, animateExpandFromSource } from '../../utils/shared-element-expand'

export function isImageGenerationTool(message: ToolMessage): boolean {
  const name = `${message.tool} ${typeof message.input?.name === 'string' ? message.input.name : ''}`
  return /image[_-]?gen|text[_-]to[_-]image|(?:image|img|picture|seedream|imagen|dall.?e).*(?:generat|creat|synth)|(?:generat|creat).*(?:image|img|picture)/i.test(name)
}

export function generatedImagesOf(message: ToolMessage): readonly Extract<ToolResultContent, { type: 'image' }>[] {
  return isImageGenerationTool(message) ? message.outputContent?.filter(
    (block): block is Extract<ToolResultContent, { type: 'image' }> => block.type === 'image',
  ) ?? [] : []
}

function GeneratedImage({ reference, workspacePath }: { readonly reference: BinaryRef; readonly workspacePath?: string }): JSX.Element {
  const { url, failed } = useGeneratedMediaUrl(reference, workspacePath)
  const [enlarged, setEnlarged] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const thumbRef = useRef<HTMLButtonElement>(null)
  const viewerImgRef = useRef<HTMLImageElement>(null)
  const closingRef = useRef(false)

  useEffect(() => {
    const element = dialog.current
    if (enlarged) {
      closingRef.current = false
      element?.showModal()
    } else if (element?.open) {
      element.close()
    }
  }, [enlarged])

  useLayoutEffect(() => {
    if (!enlarged || !url) return
    animateExpandFromSource(thumbRef.current, viewerImgRef.current)
  }, [enlarged, url])

  const requestClose = (): void => {
    if (!enlarged || closingRef.current) return
    closingRef.current = true
    animateCollapseToSource(thumbRef.current, viewerImgRef.current, () => {
      closingRef.current = false
      setEnlarged(false)
      thumbRef.current?.focus()
    })
  }

  return <figure className="generated-media__image">
    {url ? <button ref={thumbRef} type="button" className="generated-media__thumbnail" onClick={() => setEnlarged(true)} aria-label="查看图片">
      <img src={url} alt="生成的图片" loading="lazy" />
    </button> : <div className="generated-media__unavailable"><ImageIcon size={22} /><span>{failed ? '图片预览暂不可用，原文件信息已保留' : '正在载入图片…'}</span></div>}
    <dialog
      className="generated-media__viewer"
      ref={dialog}
      onClose={() => { closingRef.current = false; setEnlarged(false); thumbRef.current?.focus() }}
      onCancel={(event) => { event.preventDefault(); requestClose() }}
      onClick={(event) => { if (event.target === event.currentTarget) requestClose() }}
      aria-label="生成图片原图"
    >
      <button type="button" onClick={requestClose} aria-label="关闭图片预览"><X size={20} /></button>
      {enlarged && url && <img ref={viewerImgRef} src={url} alt="生成的图片原图" />}
    </dialog>
  </figure>
}

/** The result disclosure remains available independently of execution details.
 * BinaryRef remains the only persisted image owner; this is a projection. */
export function GeneratedMediaPreview({ message, workspacePath }: { readonly message: ToolMessage; readonly workspacePath?: string }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (!isImageGenerationTool(message)) return null
  const images = generatedImagesOf(message)
  if (!images.length) return message.status === 'running' || message.status === 'pending'
    ? <div className="generated-media__pending" role="status"><ImageIcon size={16} />正在生成图片</div> : null
  return <details className="generated-media" aria-label="图片生成结果" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="generated-media__summary"><ImageIcon size={14} aria-hidden="true" /><span>{images.length} 张图片</span><ChevronRight className="generated-media__chevron" size={13} aria-hidden="true" /></summary>
    {expanded && <div className="generated-media__grid" data-multiple={images.length > 1}>{images.map(image => <GeneratedImage key={image.ref.id} reference={image.ref} workspacePath={workspacePath} />)}</div>}
  </details>
}
