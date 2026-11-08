import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, Pencil, Plus } from 'lucide-react'
import type {
  ExpertRequest,
  ExpertVersion,
} from '../../../new trylo cli/src/internal/subagent/experts/contracts'
import type { ExpertLibraryClient } from './client'
import { ExpertConfigurationEditor } from './ExpertConfigurationEditor'
import { ExpertCatalog } from './ExpertCatalog'
import { EXPERT_REQUEST_LABELS as STATE_LABELS } from './presentation'
import { ExpertConfigurationSummary } from './ExpertConfigurationSummary'
import './experts.css'
import { LibraryDocumentReader } from '../components/tool-library/LibraryDocumentReader'
import { expertConfigurationMarkdown } from '../components/tool-library/library-documents'
import { ExpertObjectIcon } from '../components/tool-library/LibraryObjectIcon'

type Selection =
  | { readonly kind: 'browse' }
  | { readonly kind: 'new' }
  | { readonly kind: 'expert'; readonly expert: ExpertVersion }
  | { readonly kind: 'request'; readonly request: ExpertRequest }

/** Independent settings content. The caller supplies the real protocol client and surrounding shell. */
export function ExpertLibraryPanel({
  client,
  initialRequestId,
}: {
  readonly client: ExpertLibraryClient
  readonly initialRequestId?: string
}) {
  const [experts, setExperts] = useState<readonly ExpertVersion[]>([])
  const [requests, setRequests] = useState<readonly ExpertRequest[]>([])
  const [selection, setSelection] = useState<Selection>({ kind: 'browse' })
  const [documentOpen, setDocumentOpen] = useState(false)
  const [mobileDetail, setMobileDetail] = useState(false)
  const catalogEntry = useRef<HTMLButtonElement | null>(null)
  const catalogBack = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLElement | null>(null)
  const enterDetail = () => {
    catalogEntry.current =
      document.activeElement instanceof HTMLButtonElement ? document.activeElement : null
    setMobileDetail(true)
    requestAnimationFrame(() => {
      if (window.matchMedia?.('(max-width: 760px)').matches) catalogBack.current?.focus()
    })
  }
  const returnToCatalog = () => {
    setMobileDetail(false)
    requestAnimationFrame(() => {
      const entry = catalogEntry.current?.isConnected
        ? catalogEntry.current
        : (Array.from(
            panel.current?.querySelectorAll<HTMLButtonElement>('[data-expert-id]') ?? [],
          ).find(
            (button) =>
              button.dataset.expertId ===
              (selection.kind === 'expert'
                ? selection.expert.expertId
                : selection.kind === 'request'
                  ? selection.request.expertId
                  : undefined),
          ) ?? panel.current?.querySelector<HTMLButtonElement>('.expert-library__list button'))
      entry?.focus()
    })
  }
  const [search, setSearch] = useState('')
  const [queriedText, setQueriedText] = useState('')
  const [instruction, setInstruction] = useState('')
  const [feedback, setFeedback] = useState('')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingEdits, setPendingEdits] = useState(false)
  const lifecycle = useRef<AbortController | null>(null)
  const operationPending = useRef(false)

  const reload = useCallback(
    async (text: string, signal: AbortSignal) => {
      const [nextExperts, nextRequests] = await Promise.all([
        client.query(text, signal),
        client.requests(signal),
      ])
      if (signal.aborted) return
      setExperts(nextExperts)
      setQueriedText(text)
      setRequests(nextRequests)
      if (
        initialRequestId &&
        nextRequests.some((request) => request.requestId === initialRequestId)
      )
        setMobileDetail(true)
      if (
        initialRequestId &&
        !nextRequests.some((request) => request.requestId === initialRequestId)
      ) {
        setError('没有在当前工作区读到指定的专家申请，请刷新或检查来源。')
      }
      setSelection((previous) => {
        const requested = initialRequestId
          ? nextRequests.find((request) => request.requestId === initialRequestId)
          : undefined
        if (previous.kind === 'browse')
          return requested
            ? { kind: 'request', request: requested }
            : nextExperts[0]
              ? { kind: 'expert', expert: nextExperts[0] }
              : { kind: 'new' }
        return previous
      })
      setPhase('ready')
    },
    [client, initialRequestId],
  )
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    setPhase('loading')
    setSelection({ kind: 'browse' })
    setMobileDetail(false)
    setError(null)
    setBusy(false)
    operationPending.current = false
    void reload('', controller.signal).catch((cause) => {
      if (controller.signal.aborted) return
      setError(messageOf(cause))
      setPhase('error')
    })
    return () => {
      controller.abort()
      lifecycle.current = null
    }
  }, [reload])

  const perform = async (action: (signal: AbortSignal) => Promise<void>) => {
    const signal = lifecycle.current?.signal
    if (signal === undefined || signal.aborted || operationPending.current) return
    operationPending.current = true
    setBusy(true)
    setError(null)
    try {
      await action(signal)
    } catch (cause) {
      if (!signal.aborted) setError(messageOf(cause))
    } finally {
      if (!signal.aborted) {
        operationPending.current = false
        setBusy(false)
      }
    }
  }
  const showRequest = (request: ExpertRequest) => {
    setSelection({ kind: 'request', request })
    setMobileDetail(true)
    setPendingEdits(false)
  }
  const currentRequest = selection.kind === 'request' ? selection.request : undefined
  const configuration =
    selection.kind === 'expert' ? selection.expert.configuration : currentRequest?.configuration
  const reviewable =
    currentRequest !== undefined &&
    ['awaiting_retention', 'temporary'].includes(currentRequest.state)
  const create = () =>
    perform(async (signal) => {
      let request = await client.submit(
        instruction,
        selection.kind === 'expert' ? selection.expert.expertId : undefined,
        signal,
        selection.kind === 'expert' ? selection.expert : undefined,
      )
      if (signal.aborted) return
      showRequest(request)
      if (request.state === 'authorized') {
        request = await client.build(request.requestId, signal)
        if (signal.aborted) return
        showRequest(request)
      }
      await reload(search, signal)
    })
  const retain = (kind: 'save' | 'temporary') => {
    if (currentRequest === undefined) return
    return perform(async (signal) => {
      const request = await client.retain(
        currentRequest.requestId,
        { kind },
        signal,
        currentRequest,
      )
      if (signal.aborted) return
      showRequest(request)
      await reload(search, signal)
    })
  }
  return (
    <section
      ref={panel}
      className="expert-library library-reader-boundary learning-center"
      data-mobile-detail={mobileDetail}
      aria-label="Trylo 专家库"
      aria-busy={busy || phase === 'loading'}
      data-ui
    >
      <header className="expert-library__header">
        <div>
          <h2>专家库</h2>
          <p>查找适合任务的专家，阅读具体方法与依据。</p>
        </div>
        <button
          type="button"
          className="expert-button"
          disabled={busy}
          onClick={(event) => {
            event.currentTarget.focus()
            enterDetail()
            setSelection({ kind: 'new' })
            setInstruction('')
            setFeedback('')
          }}
        >
          <Plus size={16} aria-hidden="true" />
          新建专家
        </button>
      </header>
      {error !== null && (
        <div className="expert-library__error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="expert-button"
            disabled={busy}
            onClick={() => {
              void perform((signal) => reload(search, signal))
            }}
          >
            刷新
          </button>
        </div>
      )}
      <div className="expert-library__workspace">
        <ExpertCatalog
          experts={experts}
          requests={requests}
          busy={busy}
          phase={phase}
          text={search}
          queriedText={queriedText}
          selectedExpertId={selection.kind === 'expert' ? selection.expert.expertId : undefined}
          selectedRequestId={currentRequest?.requestId}
          onText={setSearch}
          onQuery={() => {
            void perform((signal) => reload(search, signal))
          }}
          onExpert={(expert) => {
            enterDetail()
            setSelection({ kind: 'expert', expert })
            setInstruction('')
            setFeedback('')
          }}
          onRequest={(request) => {
            enterDetail()
            showRequest(request)
            setFeedback(request.feedback ?? '')
          }}
        />
        <div className="expert-library__detail">
          <button
            type="button"
            ref={catalogBack}
            className="expert-button expert-library__mobile-back"
            onClick={returnToCatalog}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            返回专家列表
          </button>
          {selection.kind === 'expert' && (
            <header className="expert-library__profile-header">
              <div>
                <div className="expert-library__profile-identity">
                  <ExpertObjectIcon configuration={selection.expert.configuration} detail />
                  <h3>{selection.expert.configuration.displayName}</h3>
                </div>
                <p>{selection.expert.configuration.specialty}</p>
                <p className="expert-library__hint">
                  已保存 · v{selection.expert.version} ·{' '}
                  {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(
                    selection.expert.createdAt,
                  )}
                </p>
              </div>
              <button type="button" className="expert-button" onClick={() => setDocumentOpen(true)}>
                <BookOpen size={16} aria-hidden="true" />
                阅读完整专家说明
              </button>
            </header>
          )}
          {selection.kind === 'expert' && (
            <div className="expert-library__manual-edit">
              <button
                type="button"
                className="expert-button"
                disabled={busy}
                onClick={() => {
                  void perform(async (signal) => {
                    const request = await client.draftRevision(
                      selection.expert.expertId,
                      signal,
                      selection.expert,
                    )
                    if (signal.aborted) return
                    showRequest(request)
                    await reload(search, signal)
                  })
                }}
              >
                <Pencil size={16} aria-hidden="true" />
                编辑配置
              </button>
              <p className="expert-library__hint">
                直接调整职责、工具、技能或方法，无需重新构建。完成后重新审核长期保存。
              </p>
              <details className="expert-library__natural-revision">
                <summary>用要求生成修订</summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    void create()
                  }}
                >
                  <label>
                    <span>修改要求</span>
                    <textarea
                      rows={3}
                      value={instruction}
                      disabled={busy}
                      onChange={(event) => setInstruction(event.target.value)}
                      placeholder="说明需要调整的能力、方法或交接方式"
                    />
                  </label>
                  <button
                    type="submit"
                    className="expert-button"
                    disabled={busy || !instruction.trim()}
                  >
                    同意生成修订
                  </button>
                </form>
              </details>
            </div>
          )}
          {selection.kind === 'new' && (
            <form
              className="expert-library__create"
              onSubmit={(event) => {
                event.preventDefault()
                void create()
              }}
            >
              <h3>创建专项专家</h3>
              <label>
                <span>用自然语言描述专家</span>
                <textarea
                  required
                  rows={4}
                  maxLength={8000}
                  disabled={busy}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="例如：创建前端无障碍专家，依据 WAI 文档检查键盘导航，与验收成员交接问题"
                />
              </label>
              <p className="expert-library__hint">
                先查询已有专家，合适时直接复用。 创建获授权后会检索专项资源并构建配置。
              </p>
              <button
                type="submit"
                className="expert-button expert-button--primary"
                disabled={busy || !instruction.trim() || phase !== 'ready'}
              >
                {busy ? '正在处理…' : '同意创建并构建'}
              </button>
            </form>
          )}
          {currentRequest !== undefined && (
            <div className="expert-library__review">
              <div className="expert-library__section-title">
                <h3 className="expert-library__request-identity">
                  {currentRequest.configuration && (
                    <ExpertObjectIcon configuration={currentRequest.configuration} detail />
                  )}
                  {currentRequest.configuration?.displayName ?? '专家创建请求'}
                </h3>
                <span role="status">{STATE_LABELS[currentRequest.state]}</span>
              </div>
              <p className="expert-library__hint">{currentRequest.instruction}</p>
              {currentRequest.configuration && (
                <button
                  type="button"
                  className="expert-button"
                  onClick={() => setDocumentOpen(true)}
                >
                  <BookOpen size={16} aria-hidden="true" />
                  阅读完整候选说明
                </button>
              )}
              {['awaiting_creation', 'authorized', 'revision_requested'].includes(
                currentRequest.state,
              ) && (
                <button
                  type="button"
                  className="expert-button expert-button--primary"
                  disabled={busy}
                  onClick={() => {
                    void perform(async (signal) => {
                      let request =
                        currentRequest.state === 'awaiting_creation'
                          ? await client.authorizeCreation(
                              currentRequest.requestId,
                              signal,
                              currentRequest,
                            )
                          : currentRequest
                      if (signal.aborted) return
                      showRequest(request)
                      if (request.state === 'authorized' || request.state === 'revision_requested')
                        request = await client.build(request.requestId, signal)
                      if (signal.aborted) return
                      showRequest(request)
                      await reload(search, signal)
                    })
                  }}
                >
                  {currentRequest.state === 'awaiting_creation' ? '同意创建' : '继续构建配置'}
                </button>
              )}
              {reviewable && (
                <>
                  <p>审核专项能力、方法依据和工具引用后，决定是否长期保存。</p>
                  {pendingEdits && (
                    <p className="expert-library__hint" role="status">
                      先应用下方配置修改，再决定是否长期保存。
                    </p>
                  )}
                  <div className="expert-library__actions">
                    <button
                      type="button"
                      className="expert-button expert-button--primary"
                      disabled={busy || pendingEdits}
                      onClick={() => {
                        void retain('save')
                      }}
                    >
                      长期保存
                    </button>
                    <button
                      type="button"
                      className="expert-button"
                      disabled={busy || pendingEdits}
                      onClick={() => {
                        void retain('temporary')
                      }}
                    >
                      不长期保存
                    </button>
                  </div>
                  <p className="expert-library__hint">
                    临时专家只可用于创建申请已授权的任务，不会加入长期专家库。
                  </p>
                  <details className="expert-library__revision">
                    <summary>提出修改意见</summary>
                    <label>
                      <span>修改意见</span>
                      <textarea
                        rows={3}
                        value={feedback}
                        disabled={busy}
                        onChange={(event) => setFeedback(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="expert-button"
                      disabled={busy || pendingEdits || !feedback.trim()}
                      onClick={() => {
                        void perform(async (signal) => {
                          const request = await client.retain(
                            currentRequest.requestId,
                            { kind: 'revise', feedback },
                            signal,
                            currentRequest,
                          )
                          if (signal.aborted) return
                          showRequest(request)
                          const rebuilt = await client.build(request.requestId, signal)
                          if (signal.aborted) return
                          showRequest(rebuilt)
                          await reload(search, signal)
                        })
                      }}
                    >
                      修改后重新提交
                    </button>
                  </details>
                </>
              )}
              {currentRequest.state === 'temporary' && (
                <p className="expert-library__hint">
                  该专家未长期入库，可在本次创建授权允许的范围内使用。
                </p>
              )}
            </div>
          )}
          {configuration !== undefined &&
            (reviewable && currentRequest !== undefined ? (
              <ExpertConfigurationEditor
                key={`${currentRequest.requestId}:${currentRequest.revision}`}
                configuration={configuration}
                disabled={busy}
                onDirty={() => setPendingEdits(true)}
                onApply={(edits) =>
                  perform(async (signal) => {
                    const request = await client.edit(
                      currentRequest.requestId,
                      edits,
                      signal,
                      currentRequest,
                    )
                    if (signal.aborted) return
                    showRequest(request)
                    await reload(search, signal)
                  })
                }
              />
            ) : (
              <ExpertConfigurationSummary configuration={configuration} />
            ))}
        </div>
      </div>
      {documentOpen && configuration && (
        <LibraryDocumentReader
          backLabel="返回专家库"
          title={`${configuration.displayName} · ${selection.kind === 'expert' ? `v${selection.expert.version}` : `申请修订 r${currentRequest?.revision}`}`}
          document={{
            name: 'EXPERT.md',
            content: expertConfigurationMarkdown(configuration),
            source: JSON.stringify(
              selection.kind === 'expert' ? selection.expert : currentRequest,
              null,
              2,
            ),
          }}
          onClose={() => setDocumentOpen(false)}
        />
      )}
    </section>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : '专家库操作未完成，请刷新后重试。'
}
