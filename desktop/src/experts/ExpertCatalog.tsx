import type {
  ExpertRequest,
  ExpertVersion,
} from '../../../new trylo cli/src/internal/subagent/experts/contracts'
import { EXPERT_REQUEST_LABELS, EXPERT_ROLE_LABELS } from './presentation'
import { Search, UserRound } from 'lucide-react'
import { ExpertObjectIcon } from '../components/tool-library/LibraryObjectIcon'

/** Read-only catalog; selection and all lifecycle actions stay with the panel/client. */
export function ExpertCatalog({
  experts,
  requests,
  busy,
  phase,
  text,
  queriedText,
  selectedExpertId,
  selectedRequestId,
  onText,
  onQuery,
  onExpert,
  onRequest,
}: {
  readonly experts: readonly ExpertVersion[]
  readonly requests: readonly ExpertRequest[]
  readonly busy: boolean
  readonly phase: 'loading' | 'ready' | 'error'
  readonly text: string
  readonly queriedText: string
  readonly selectedExpertId?: string
  readonly selectedRequestId?: string
  readonly onText: (text: string) => void
  readonly onQuery: () => void
  readonly onExpert: (expert: ExpertVersion) => void
  readonly onRequest: (request: ExpertRequest) => void
}) {
  const pending = requests.filter((item) => item.state !== 'saved' && item.state !== 'rejected')
  return (
    <aside className="expert-library__catalog" aria-label="已保存专家与请求">
      <form
        className="expert-library__search"
        onSubmit={(event) => {
          event.preventDefault()
          onQuery()
        }}
      >
        <label>
          <span>查询已有专家</span>
          <input
            type="search"
            value={text}
            onChange={(event) => onText(event.target.value)}
            placeholder="专长、职责或适用情境"
          />
        </label>
        <button type="submit" className="expert-button" disabled={busy || phase === 'loading'}>
          <Search size={16} aria-hidden="true" />
          查询
        </button>
      </form>
      {phase === 'loading' && <p role="status">正在读取专家库…</p>}
      {phase === 'ready' && (
        <>
          <p className="expert-library__hint">
            {experts.length} 位已保存专家{queriedText.trim() ? `匹配“${queriedText}”` : ''}
          </p>
          {experts.length === 0 && (
            <p className="expert-library__empty">
              {queriedText.trim() ? '没有匹配的专家，可调整查询或新建。' : '还没有长期保存的专家。'}
            </p>
          )}
        </>
      )}
      <ul className="expert-library__list">
        {experts.map((expert) => (
          <li key={expert.expertId}>
            <button
              type="button"
              data-expert-id={expert.expertId}
              disabled={busy}
              aria-pressed={selectedExpertId === expert.expertId}
              onClick={(event) => {
                event.currentTarget.focus()
                onExpert(expert)
              }}
            >
              <span className="expert-library__entry-title">
                <ExpertObjectIcon configuration={expert.configuration} />
                <strong>{expert.configuration.displayName}</strong>
              </span>
              <span>{expert.configuration.specialty}</span>
              <small>
                {EXPERT_ROLE_LABELS[expert.configuration.baseRole]} · v{expert.version}
              </small>
            </button>
          </li>
        ))}
      </ul>
      {pending.length > 0 && (
        <div className="expert-library__requests">
          <h3>待处理与临时专家</h3>
          <ul className="expert-library__list">
            {pending.map((request) => (
              <li key={request.requestId}>
                <button
                  type="button"
                  data-expert-request-id={request.requestId}
                  disabled={busy}
                  aria-pressed={selectedRequestId === request.requestId}
                  onClick={(event) => {
                    event.currentTarget.focus()
                    onRequest(request)
                  }}
                >
                  <span className="expert-library__entry-title">
                    {request.configuration ? (
                      <ExpertObjectIcon configuration={request.configuration} />
                    ) : (
                      <span className="library-object-icon" aria-hidden="true">
                        <UserRound size={16} aria-hidden="true" />
                      </span>
                    )}
                    <strong>{request.configuration?.displayName ?? request.instruction}</strong>
                  </span>
                  <small>{EXPERT_REQUEST_LABELS[request.state]}</small>
                  <span>继续审核</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  )
}
