import { useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, CircleCheck, CircleHelp, CircleMinus, RefreshCw } from 'lucide-react'
import type {
  ToolLibraryCatalog,
  ToolLibraryClient,
  ToolLibraryContext,
  ToolLibraryItem,
} from '../../tool-library/client'
import type { CapabilityRequest } from '../../../../new trylo cli/src/internal/tooling/library/contracts'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import { ToolProductionPanel } from '../user-learning/ToolProductionPanel'
import { LibraryDocumentReader } from './LibraryDocumentReader'
import { ToolObjectIcon } from './LibraryObjectIcon'
import { toolLibraryMarkdown, toolAvailabilityLabel, toolLifecycleLabel } from './library-documents'
import './tool-library.css'

export type ToolLibraryPanelProps = {
  readonly client?: ToolLibraryClient
  readonly context: ToolLibraryContext
  readonly runtime?: ToolLearningRuntime
  readonly initialRequestId?: string
}
const originLabel = {
  builtin: '内置',
  mcp: 'MCP',
  plugin: '插件',
  learned: '学习产物',
  external: '外部工具',
}
const stateLabel = toolAvailabilityLabel

/** Independent settings component. Member/configuration ownership stays in the host. */
export function ToolLibraryPanel({
  client,
  context,
  runtime,
  initialRequestId,
}: ToolLibraryPanelProps) {
  const capabilityInputId = useId()
  const [catalog, setCatalog] = useState<ToolLibraryCatalog>(),
    [selected, setSelected] = useState<readonly string[]>([])
  const [query, setQuery] = useState(''),
    [origin, setOrigin] = useState('all'),
    [detailId, setDetailId] = useState<string>()
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string>()
  const [capability, setCapability] = useState(''),
    [revision, setRevision] = useState(''),
    [request, setRequest] = useState<CapabilityRequest>(),
    [refresh, setRefresh] = useState(0)
  const pending = useRef<AbortController>(),
    generation = useRef(0)
  const memberId = context.memberId,
    scope = context.scope
  const [documentOpen, setDocumentOpen] = useState(false)
  const [view, setView] = useState<'catalog' | 'production'>('catalog')
  const [mobileDetail, setMobileDetail] = useState(false)
  const detailEntry = useRef<HTMLButtonElement | null>(null)
  const detailBack = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLElement | null>(null)
  const openDetail = (id: string, trigger: HTMLButtonElement) => {
    detailEntry.current = trigger
    setDetailId(id)
    setMobileDetail(true)
    requestAnimationFrame(() => {
      if (window.matchMedia?.('(max-width: 760px)').matches) detailBack.current?.focus()
    })
  }
  const returnToCatalog = () => {
    setMobileDetail(false)
    requestAnimationFrame(() => {
      const entry = detailEntry.current?.isConnected
        ? detailEntry.current
        : Array.from(
            panel.current?.querySelectorAll<HTMLButtonElement>('[data-tool-detail-id]') ?? [],
          ).find((button) => button.dataset.toolDetailId === detailId)
      if (entry) entry.focus()
      else panel.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
    })
  }
  useEffect(() => {
    setRequest(undefined)
    if (!initialRequestId || !client) return
    const controller = new AbortController()
    void client
      .getRequest({ memberId, scope }, initialRequestId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        if (result.ok && result.value.requestId === initialRequestId) setRequest(result.value)
        else if (result.ok) setNotice('申请响应与当前请求不一致，请刷新后重试。')
        else setNotice(`${result.code}：${result.message}`)
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setNotice(error instanceof Error ? error.message : '申请读取失败。')
      })
    return () => controller.abort()
  }, [client, memberId, scope, initialRequestId, refresh])
  useEffect(() => {
    const controller = new AbortController(),
      current = ++generation.current
    pending.current?.abort()
    pending.current = undefined
    setBusy(false)
    setLoading(true)
    setNotice(undefined)
    setCatalog(undefined)
    setSelected([])
    setRequest(undefined)
    setDetailId(undefined)
    setMobileDetail(false)
    if (!client) {
      setLoading(false)
      return () => controller.abort()
    }
    void client
      .query({ memberId, scope }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || current !== generation.current) return
        if (result.ok) {
          setCatalog(result.value)
          setSelected(result.value.items.filter((item) => item.configured).map((item) => item.id))
          setDetailId(result.value.items[0]?.id)
        } else setNotice(`${result.code}：${result.message}`)
        setLoading(false)
      })
      .catch((error) => {
        if (controller.signal.aborted || current !== generation.current) return
        setNotice(error instanceof Error ? error.message : '工具目录读取失败。')
        setLoading(false)
      })
    return () => {
      controller.abort()
      pending.current?.abort()
    }
  }, [client, memberId, scope, refresh])
  const rows =
    catalog?.items.filter(
      (item) =>
        (origin === 'all' || item.source.kind === origin) &&
        [item.name, item.description, ...item.capabilities, item.source.label]
          .join(' ')
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    ) ?? []
  const detail = catalog?.items.find((item) => item.id === detailId)
  const truncated = catalog !== undefined && catalog.total > catalog.items.length
  async function act(operation: 'configure' | 'request' | 'status' | 'revise') {
    if (!client || busy || loading) return
    const controller = new AbortController(),
      current = generation.current
    pending.current = controller
    setBusy(true)
    setNotice(undefined)
    let configurationSaved = false
    try {
      if (operation === 'configure') {
        const result = await client.configure({ memberId, scope }, selected, controller.signal)
        if (current !== generation.current || controller.signal.aborted) return
        if (!result.ok) {
          setNotice(`${result.code}：${result.message}`)
          return
        }
        configurationSaved = true
        const updated = await client.query({ memberId, scope }, controller.signal)
        if (current !== generation.current || controller.signal.aborted) return
        if (updated.ok) {
          setCatalog(updated.value)
          setSelected(updated.value.items.filter((item) => item.configured).map((item) => item.id))
          setNotice('成员工具配置已保存，后续任务会使用此选择。')
        } else {
          setCatalog(undefined)
          setNotice(
            `成员工具配置已保存，但状态刷新失败（${updated.code}：${updated.message}）。请刷新确认当前选择。`,
          )
        }
      } else if (operation === 'request' || operation === 'revise') {
        const revising = operation === 'revise' && detail?.source.kind === 'learned'
        const text = revising
          ? `修改 ${detail.name}：${revision.trim()}`.slice(0, 512)
          : capability.trim()
        const result = await client.requestCapability(
          { memberId, scope },
          {
            requestKey: revising ? `revision:${revision.trim()}` : text,
            capability: text,
            taskId: 'tool-library-settings',
            ...(revising ? { targetToolId: detail.id } : {}),
          },
          controller.signal,
        )
        if (current !== generation.current || controller.signal.aborted) return
        if (!result.ok) setNotice(`${result.code}：${result.message}`)
        else if (result.value.kind === 'existing')
          setNotice(`已有 ${result.value.references.length} 项可用能力，可在目录中选用。`)
        else {
          setRequest(result.value.request)
          setNotice('需求已交给中央调度。完成后仍需审阅，才能长期入库。')
        }
      } else if (request) {
        const result = await client.getRequest(
          { memberId, scope },
          request.requestId,
          controller.signal,
        )
        if (current !== generation.current || controller.signal.aborted) return
        if (result.ok) setRequest(result.value)
        else setNotice(`${result.code}：${result.message}`)
      }
    } catch (error) {
      if (current === generation.current && !controller.signal.aborted) {
        if (configurationSaved) setCatalog(undefined)
        setNotice(
          configurationSaved
            ? '成员工具配置已保存，但状态刷新失败。请刷新确认当前选择。'
            : error instanceof Error
              ? error.message
              : '操作失败，请刷新当前状态。',
        )
      }
    } finally {
      if (pending.current === controller) {
        pending.current = undefined
        setBusy(false)
      }
    }
  }
  return (
    <section
      ref={panel}
      className="tool-library library-reader-boundary learning-center"
      data-mobile-detail={mobileDetail}
      aria-label="统一工具库"
      aria-busy={loading || busy}
    >
      <header className="tool-library__header">
        <div>
          <h3>工具库</h3>
          <p>找到能完成当前工作的工具，查看能力与来源，再为成员选用。</p>
        </div>
        <button
          type="button"
          disabled={busy || loading || !client}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={16} aria-hidden="true" />
          刷新
        </button>
      </header>
      {runtime && (
        <nav className="tool-library__tabs" aria-label="工具库视图">
          <button
            type="button"
            aria-pressed={view === 'catalog'}
            onClick={() => setView('catalog')}
          >
            工具目录
          </button>
          <button
            type="button"
            aria-pressed={view === 'production'}
            onClick={() => setView('production')}
          >
            入库与版本
          </button>
        </nav>
      )}
      {!client ? <p role="status">工具库尚未连接当前工作区。</p> : null}
      {notice ? (
        <p className="tool-library__notice" role="status">
          {notice}
        </p>
      ) : null}
      {loading ? <p role="status">正在读取工具来源与成员配置…</p> : null}
      {catalog && view === 'catalog' ? (
        <>
          <div className="tool-library__catalog-controls">
            <div className="tool-library__filters">
              <input
                type="search"
                aria-label="搜索工具库"
                placeholder="名称、用途或能力"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <select
                aria-label="工具来源"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
              >
                <option value="all">全部来源</option>
                {Object.entries(originLabel).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <p className="tool-library__meta">
              显示 {rows.length} / {catalog.total} 项 · 当前成员已配置{' '}
              {catalog.items.filter((item) => item.configured).length} 项
            </p>
            {truncated ? (
              <p role="status">目录超过本次显示上限。为保留未显示的配置，本页暂不保存选择。</p>
            ) : null}
          </div>
          <div className="tool-library__workspace">
            <div className="tool-library__list">
              {rows.map((item) => (
                <ToolRow
                  key={item.id}
                  item={item}
                  selected={selected.includes(item.id)}
                  busy={busy}
                  inspected={detailId === item.id}
                  onInspect={(trigger) => openDetail(item.id, trigger)}
                  onSelect={(checked) =>
                    setSelected((previous) =>
                      checked
                        ? [...new Set([...previous, item.id])]
                        : previous.filter((id) => id !== item.id),
                    )
                  }
                />
              ))}
              {rows.length === 0 ? <p>没有匹配的工具。可清除筛选，或提交能力补齐需求。</p> : null}
            </div>
            {detail ? (
              <aside className="tool-library__detail" aria-label="工具详情">
                <button
                  type="button"
                  ref={detailBack}
                  className="tool-library__mobile-back"
                  onClick={returnToCatalog}
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                  返回工具目录
                </button>
                <div className="tool-library__identity">
                  <ToolObjectIcon item={detail} detail />
                  <h4>{detail.name}</h4>
                </div>
                <p>{detail.description}</p>
                <button
                  type="button"
                  className="tool-library__read"
                  onClick={() => setDocumentOpen(true)}
                >
                  <BookOpen size={16} aria-hidden="true" />
                  阅读完整工具说明
                </button>
                <h5>可做什么</h5>
                <ul className="tool-library__capabilities">
                  {detail.capabilities.map((capability) => (
                    <li key={capability}>{capability}</li>
                  ))}
                </ul>
                <h5>调用入口</h5>
                <code className="tool-library__runtime">
                  {detail.runtimeName ?? '尚无运行时入口'}
                </code>
                <dl>
                  <dt>来源</dt>
                  <dd>
                    {originLabel[detail.source.kind]} · {detail.source.label}
                  </dd>
                  <dt>版本 / 记录</dt>
                  <dd>
                    {detail.source.version ?? '—'}
                    <br />
                    {detail.source.reference ?? detail.id}
                  </dd>
                  <dt>状态</dt>
                  <dd>
                    <ToolAvailability state={detail.availability.state} /> ·{' '}
                    {toolLifecycleLabel(detail.lifecycle)}
                    {detail.reason ? ` · ${detail.reason}` : ''}
                  </dd>
                </dl>
                {detail.source.kind === 'learned' ? (
                  <details>
                    <summary>提出工具修改要求</summary>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault()
                        void act('revise')
                      }}
                    >
                      <label>
                        修改要求
                        <textarea
                          value={revision}
                          maxLength={400}
                          onChange={(event) => setRevision(event.target.value)}
                          disabled={busy}
                        />
                      </label>
                      <button type="submit" disabled={busy || !revision.trim()}>
                        提交修改要求
                      </button>
                      <p className="tool-library__meta">
                        将关联当前资产提交给原工具学习队列，保留已启用版本。修改产物仍需审阅。
                      </p>
                    </form>
                  </details>
                ) : null}
              </aside>
            ) : null}
          </div>
          <div className="tool-library__actions">
            <button
              type="button"
              disabled={busy || loading || truncated}
              onClick={() => void act('configure')}
            >
              保存成员工具配置
            </button>
          </div>
        </>
      ) : null}
      {view === 'catalog' && (
        <details className="tool-library__demand-section">
          <summary>没有找到需要的工具？补齐能力</summary>
          <form
            className="tool-library__demand"
            onSubmit={(event) => {
              event.preventDefault()
              void act('request')
            }}
          >
            <label htmlFor={capabilityInputId}>补齐所需能力</label>
            <p className="tool-library__meta">
              优先复用现有工具。需要寻找、适配或创建时，先请求你的同意。
            </p>
            <div className="tool-library__actions">
              <input
                id={capabilityInputId}
                value={capability}
                maxLength={512}
                placeholder="描述需要完成的操作"
                onChange={(event) => setCapability(event.target.value)}
                disabled={busy}
              />
              <button type="submit" disabled={!client || loading || busy || !capability.trim()}>
                提交需求
              </button>
            </div>
          </form>
        </details>
      )}
      {request ? (
        <section aria-label="能力补齐处理结果">
          <p>
            {request.capability} · {request.state}
          </p>
          <p className="tool-library__meta">{request.reason ?? request.requestId}</p>
          {request.toolIds.length > 0 ? <p>已有可配置的运行时工具。刷新目录后选用。</p> : null}
          <button type="button" disabled={busy} onClick={() => void act('status')}>
            查询处理结果
          </button>
        </section>
      ) : null}
      {busy ? (
        <button
          type="button"
          onClick={() => {
            pending.current?.abort()
            setBusy(false)
            setNotice('已停止等待，请重新读取状态以确认操作结果。')
          }}
        >
          停止等待
        </button>
      ) : null}
      {runtime && view === 'production' ? (
        <section className="tool-library__review" aria-label="学习工具审阅与长期入库">
          <ToolProductionPanel runtime={runtime} />
        </section>
      ) : null}
      {documentOpen && detail && (
        <LibraryDocumentReader
          backLabel="返回工具库"
          title={`${detail.name} · ${detail.source.version ?? '当前目录记录'}`}
          document={{
            name: `${detail.name}.md`,
            content: toolLibraryMarkdown(detail),
            source: JSON.stringify(detail, null, 2),
          }}
          onClose={() => setDocumentOpen(false)}
        />
      )}
    </section>
  )
}
function ToolRow({
  item,
  selected,
  busy,
  inspected,
  onSelect,
  onInspect,
}: {
  item: ToolLibraryItem
  selected: boolean
  busy: boolean
  inspected: boolean
  onSelect: (checked: boolean) => void
  onInspect: (trigger: HTMLButtonElement) => void
}) {
  return (
    <article className="tool-library__row" data-selected={inspected}>
      <label>
        <input
          type="checkbox"
          checked={selected}
          disabled={busy || (item.configuration === 'blocked' && !selected)}
          onChange={(event) => onSelect(event.target.checked)}
        />
        <span>
          <span className="tool-library__row-title">
            <ToolObjectIcon item={item} />
            <strong>{item.name}</strong>
          </span>
          <span className="tool-library__description">{item.description}</span>
          <span className="tool-library__meta">
            {originLabel[item.source.kind]} · <ToolAvailability state={item.availability.state} /> ·{' '}
            {item.configured ? '成员已配置' : '成员未配置'}
            {item.reason ? ` · ${item.reason}` : ''}
          </span>
        </span>
      </label>
      <button
        type="button"
        data-tool-detail-id={item.id}
        onClick={(event) => onInspect(event.currentTarget)}
        aria-label={`查看 ${item.name} 来源和状态`}
      >
        详情
      </button>
    </article>
  )
}

function ToolAvailability({ state }: { state: ToolLibraryItem['availability']['state'] }) {
  const Icon = state === 'available' ? CircleCheck : state === 'unavailable' ? CircleMinus : CircleHelp
  return (
    <span className="tool-library__availability">
      <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
      {stateLabel[state]}
    </span>
  )
}
