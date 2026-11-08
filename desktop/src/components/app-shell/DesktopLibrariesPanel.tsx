import { useEffect, useState } from 'react'
import { UserRound, Wrench } from 'lucide-react'
import { ToolLibraryPanel } from '../tool-library/ToolLibraryPanel'
import { ExpertLibraryPanel } from '../../experts'
import type { DesktopCollaborationResources } from '../../collaboration-learning/desktop-resources'
import { ApprovalCard } from '../chat/ApprovalCard'
import type { ChatMessage } from '../chat/types'
import './desktop-libraries.css'
import { LibraryProcessRecovery } from './LibraryProcessRecovery'

export type LibraryRequestFocus = { readonly owner: 'tool' | 'expert'; readonly requestId: string }

/** Surrounds the libraries' original views; all mutations remain in their own clients and UI. */
export function DesktopLibrariesPanel({
  resources,
  focus,
  initialOwner,
  approvals = [],
  onRespondApproval,
  onRequestTemporaryExpert,
}: {
  readonly resources?: DesktopCollaborationResources
  readonly focus?: LibraryRequestFocus
  readonly initialOwner?: 'tool' | 'expert'
  readonly approvals?: readonly ChatMessage[]
  readonly onRespondApproval?: (id: string, allow: boolean) => void
  readonly onRequestTemporaryExpert?: () => void
}) {
  const [owner, setOwner] = useState<'tool' | 'expert'>(focus?.owner ?? initialOwner ?? 'tool')
  useEffect(() => {
    setOwner(focus?.owner ?? initialOwner ?? 'tool')
  }, [focus?.owner, focus?.requestId, initialOwner])
  return (
    <div className="desktop-libraries">
      {resources?.libraryRecovery && <LibraryProcessRecovery port={resources.libraryRecovery} />}
      {approvals.map((message) =>
        message.kind === 'approval' ? (
          <ApprovalCard
            key={message.id}
            message={{
              ...message,
              description:
                typeof message.pendingRequest?.input.summary === 'string'
                  ? message.pendingRequest.input.summary
                  : typeof message.pendingRequest?.input.capability === 'string'
                    ? message.pendingRequest.input.capability
                    : message.description,
            }}
            onRespond={onRespondApproval}
          />
        ) : null,
      )}
      <div className="desktop-libraries__switch">
        <button
          type="button"
          className="settings-modal__btn settings-modal__btn--ghost"
          aria-pressed={owner === 'tool'}
          onClick={() => setOwner('tool')}
        >
          <Wrench size={16} aria-hidden="true" />
          工具库
        </button>
        <button
          type="button"
          className="settings-modal__btn settings-modal__btn--ghost"
          aria-pressed={owner === 'expert'}
          onClick={() => setOwner('expert')}
        >
          <UserRound size={16} aria-hidden="true" />
          专家库
        </button>
      </div>
      {focus?.owner === owner && (
        <p role="status">
          当前申请：<code>{focus.requestId}</code>
        </p>
      )}
      {!resources ? (
        <p role="status">尚未连接当前工作区的 CLI，暂时无法读取能力库。</p>
      ) : owner === 'tool' ? (
        <ToolLibraryPanel
          key={`${resources.scope}:tool`}
          client={resources.tools}
          context={{ memberId: 'personal_agent', scope: resources.scope }}
          runtime={resources.runtime}
          initialRequestId={focus?.owner === 'tool' ? focus.requestId : undefined}
        />
      ) : (
        <>
          {onRequestTemporaryExpert && (
            <button
              type="button"
              className="settings-modal__btn settings-modal__btn--ghost"
              onClick={onRequestTemporaryExpert}
            >
              向当前 Personal Agent 申请临时专家
            </button>
          )}
          <ExpertLibraryPanel
            key={`${resources.scope}:expert`}
            client={resources.experts}
            initialRequestId={focus?.owner === 'expert' ? focus.requestId : undefined}
          />
          <details className="desktop-libraries__temporary-help">
            <summary>临时专家与团队使用</summary>
            <p className="settings-modal__hint">
              “不入库”不代表当前团队已采用；临时专家由当前任务确认安排。
            </p>
          </details>
        </>
      )}
    </div>
  )
}
