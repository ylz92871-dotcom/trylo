import {
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, BookOpen, Code2, Copy, FileText, List, RefreshCw, X } from 'lucide-react'
import { markdownBody, type LearningDocument } from './learning-document'
import '../../styles/components/learning-center.css'

export function LearningMarkdown({ content }: { content: string }): ReactElement {
  return (
    <div className="learning-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) =>
            /^https?:\/\//i.test(href ?? '') ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span
                className="learning-reference"
                title={href ? `引用文件：${href}；当前提案未提供该文件内容。` : undefined}
              >
                {children}
              </span>
            ),
          img: ({ alt, src }) => (
            <span className="learning-image-reference">图片：{alt || src || '未命名'}</span>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="learning-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {markdownBody(content)}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ children }: { children: ReactNode }): ReactElement {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  return (
    <div className="learning-code">
      <span className="learning-code__language">
        {isValidElement<{ className?: string }>(children)
          ? (children.props.className?.replace(/^language-/, '') ?? 'code')
          : 'code'}
      </span>
      <button
        type="button"
        aria-label="复制代码"
        onClick={() => {
          if (!navigator.clipboard) {
            setError(true)
            return
          }
          void navigator.clipboard.writeText(ref.current?.textContent ?? '').then(
            () => {
              setCopied(true)
              setError(false)
            },
            () => setError(true),
          )
        }}
      >
        <Copy size={13} />
        {error ? '复制失败' : copied ? '已复制' : '复制'}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

export interface LearningDocumentReaderProps {
  title: string
  backLabel?: string
  document?: LearningDocument
  loading?: boolean
  error?: string | null
  onClose: () => void
  onRetry?: () => void
  actions?: ReactNode
  status?: ReactNode
  busy?: boolean
}

export function LearningDocumentReader(props: LearningDocumentReaderProps): ReactElement {
  const [view, setView] = useState<'read' | 'diff' | 'source'>('read')
  const [outline, setOutline] = useState(false)
  const [metadata, setMetadata] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const positions = useRef<Record<string, number>>({})
  const [headings, setHeadings] = useState<{ text: string; index: number; level: string }[]>([])
  const close = useRef<HTMLButtonElement>(null)
  const outlineToggle = useRef<HTMLButtonElement>(null)
  const onClose = useRef(props.onClose)
  const busy = useRef(props.busy)
  onClose.current = props.onClose
  busy.current = props.busy
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const siblings: { element: HTMLElement; inert: boolean }[] = []
    let current: HTMLElement | null = root.current
    while (current?.parentElement && !current.classList.contains('learning-center')) {
      for (const sibling of Array.from(current.parentElement.children)) {
        if (sibling !== current && sibling instanceof HTMLElement) {
          siblings.push({ element: sibling, inert: sibling.inert })
          sibling.inert = true
        }
      }
      current = current.parentElement
    }
    close.current?.focus()
    // Directory items are transient controls. Keep Escape available if a browser
    // or assistive technology leaves focus on the document between controls.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !root.current?.isConnected) return
      event.preventDefault()
      event.stopPropagation()
      if (!busy.current) onClose.current()
    }
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('keydown', escape)
      siblings.forEach(({ element, inert }) => {
        element.inert = inert
      })
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    setHeadings(
      Array.from(body.current?.querySelectorAll('h1,h2,h3') ?? []).map((h, index) => ({
        text: h.textContent ?? '',
        index,
        level: h.tagName,
      })),
    )
    if (body.current) body.current.scrollTop = positions.current[view] ?? 0
  }, [view, props.document])
  function changeView(next: typeof view) {
    positions.current[view] = body.current?.scrollTop ?? 0
    setView(next)
    setOutline(false)
  }
  return (
    <div
      ref={root}
      className="learning-reader"
      role="region"
      aria-label="学习文档阅读"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          if (!props.busy) props.onClose()
        }
      }}
    >
      <header className="learning-reader__header">
        <button ref={close} type="button" disabled={props.busy} onClick={props.onClose}>
          <ArrowLeft size={16} />
          {props.backLabel ?? '智能体学习'}
        </button>
        <span>{props.title}</span>
        <button type="button" aria-label="关闭文档" disabled={props.busy} onClick={props.onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="learning-reader__toolbar">
        <span title={props.document?.name}>
          <FileText size={15} />
          {props.document?.name ?? '文档'}
        </span>
        <nav aria-label="文档视图">
          <button type="button" aria-pressed={view === 'read'} onClick={() => changeView('read')}>
            <BookOpen size={14} />
            阅读
          </button>
          <button
            type="button"
            disabled={!props.document?.diff}
            title={!props.document?.diff ? '后端未提供差异' : undefined}
            aria-pressed={view === 'diff'}
            onClick={() => changeView('diff')}
          >
            差异
          </button>
          <button
            type="button"
            aria-pressed={view === 'source'}
            onClick={() => changeView('source')}
          >
            <Code2 size={14} />
            源码
          </button>
        </nav>
        {props.onRetry ? (
          <button
            type="button"
            aria-label="重新加载内容"
            disabled={props.busy || props.loading}
            onClick={props.onRetry}
          >
            <RefreshCw size={14} />
          </button>
        ) : null}
        <button
          ref={outlineToggle}
          type="button"
          aria-expanded={outline}
          disabled={view !== 'read' || headings.length === 0}
          onClick={() => setOutline(!outline)}
        >
          <List size={15} />
          目录
        </button>
      </div>
      {outline ? (
        <nav className="learning-reader__outline" aria-label="文档目录">
          {headings.map((h) => (
            <button
              type="button"
              key={h.index}
              className={h.level.toLowerCase()}
              onClick={() => {
                body.current
                  ?.querySelectorAll('h1,h2,h3')
                  .item(h.index)
                  ?.scrollIntoView({ block: 'start' })
                setOutline(false)
                outlineToggle.current?.focus()
              }}
            >
              {h.text}
            </button>
          ))}
        </nav>
      ) : null}
      <div ref={body} className="learning-reader__body">
        {props.loading ? (
          <p role="status">正在读取完整内容…</p>
        ) : props.error ? (
          <div role="alert">
            <p>读不到完整内容：{props.error}</p>
            {props.onRetry ? (
              <button type="button" onClick={props.onRetry}>
                重新加载
              </button>
            ) : null}
          </div>
        ) : props.document ? (
          <article className="learning-reader__article">
            {view === 'read' ? (
              props.document.content.trim() ? (
                <LearningMarkdown content={props.document.content} />
              ) : (
                <p className="learning-inspector__empty">这份文档暂无内容。</p>
              )
            ) : (
              <pre className="learning-reader__source">
                {view === 'diff' ? props.document.diff : props.document.source}
              </pre>
            )}
          </article>
        ) : null}
      </div>
      {metadata && props.document ? (
        <div className="learning-reader__metadata">
          <header>
            <strong>写入详情</strong>
            <button type="button" aria-label="关闭写入详情" onClick={() => setMetadata(false)}>
              <X size={16} />
            </button>
          </header>
          <pre>{props.document.metadata ?? props.document.source}</pre>
        </div>
      ) : null}
      <footer className="learning-reader__footer">
        <div>
          <button type="button" disabled={!props.document} onClick={() => setMetadata(!metadata)}>
            写入详情
          </button>
          <span>{props.status ?? '已批准内容 · 只读'}</span>
        </div>
        <div className="learning-reader__actions">{props.actions}</div>
      </footer>
    </div>
  )
}
