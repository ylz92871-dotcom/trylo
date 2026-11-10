// Trylo Desktop — Message. See docs/spikes/phase-2-ui-redesign.md.
//
// v1.15.7: closer to cline. No more brand-tinted bubble
// for the assistant — the reply is plain markdown-flavoured
// text. User messages keep a subtle surface so the sender
// is visually distinct from the model. The role pill is
// gone — cline doesn't use it either.
//
// v1.15.9: forward `turnStartedAt` + `isFirstInTurn` to
// ThinkingCard so <TurnProgress /> can show above the
// first thinking card of the active turn.
//
//   text (user)       → right-aligned, soft surface
//   text (assistant)  → plain text, no bubble
//   thinking          → ThinkingCard (collapsible)
//   tool              → ToolCard (one-line collapsed,
//                        expanded on click)
//   notice / turn /   → dropped upstream in events.ts,
//     subagent / …      this component never sees them
//   compaction        → CompactionCard (context boundary)
//
// v1.16.3: inline-edit for past user messages. Click a
// user message → the <p> swaps for a <textarea> + Save
// / Cancel. The Message component owns a local
// textarea mirror so the user's typing doesn't fight a
// parent re-render. The hooks (useState / useEffect)
// live at the TOP of the function — placing them inside
// a switch case is a Rules of Hooks violation and
// crashes the message tree.
//
// Whole-turn duration is rendered by MessageList after the final turn content.

import { memo, useEffect, useState, type ReactElement } from 'react';
import { CircleAlert, Rocket } from 'lucide-react';
import { RuntimeNotice } from './RuntimeNotice';
import { WorkflowReceipt } from './WorkflowReceipt';
import { isWorkflowState } from '../../domain/workflow-state';
import { AssistantAnswer } from './AssistantAnswer';
import type { ChatMessage } from './types';
import { ToolCard } from './ToolCard';
import { FileChangeCards } from './FileChangeCard';
import { computeFileChanges } from './file-change';
import { ThinkingCard } from './ThinkingCard';
import { CompactionCard, compactionNoticePresentation } from './CompactionCard';
import { ErrorCard } from './ErrorCard';
// 2026-08-29 (Work workflow UI refactor, spec §3.1):
// the WorkWorkflowCard was the hierarchy container for
// one run; it never falls through to the default
// renderer.
// 2026-09-10 (applyWorkItem deletion面): WorkWorkflowCard deleted with the
// WorkflowMessage chain (zero production producers) — the branch below
// went with it. The linear rail (WorkPhaseRail, `work_rail`) is a
// DIFFERENT message kind and stays.
// 2026-08-29 (linear Work UI, spec §4): the four linear
// components the safety-net branches below fall back to.
import { WorkPhaseRail } from './WorkPhaseRail';
import { WorkNarration } from './WorkNarration';
import { DeliverableProgressPanel } from './DeliverableProgressPanel';
// M4-E (spec §6.7 Core "approval / input"): inline
// decision cards for daemon permission requests and
// structured user-input question sets.
import { ApprovalMessageRow } from './ApprovalMessageRow';
import { CognitionPromptCard } from '../user-learning/CognitionPromptCard';
import { LearningImpactCard } from '../user-learning/LearningImpactCard';
import { SubagentCard } from './SubagentCard';
// v1.16.5+ (M3): Work capability renders inline through
// the SAME card the Work sub-app ships — no second
// artifact component.
import { ArtifactCard } from './ArtifactCard';
import { relativeArtifactPath } from '../../results/artifact-paths';
import type { ArtifactHost as HostAdapter } from '../../host-adapter/artifact-actions';
import { resolveArtifactKind } from './artifact-kind';

export interface MessageProps {
  readonly message: ChatMessage;
  // v1.16.4: per-turn timer plumbing. MessageList looks
  // up the user message that started this turn (via
  // turnId) and passes its timer fields down. For
  // non-thinking messages these are unused; the
  // ThinkingCard forwarder is the only consumer.
  readonly turnStartedAt?: number | null;
  readonly finalElapsedMs?: number;
  /** True when this turn is the active one (last user
   *  message AND CLI still running). For non-thinking
   *  messages, unused. */
  readonly isTurnActive?: boolean;
  // v1.15.9: kept for backward compat with the
  // ThinkingCard case. v1.16.4.1: no longer the timer
  // trigger — the user message row owns the timer now.
  readonly isFirstInTurn?: boolean;
  // v1.16.3: inline-edit. When editingMessageId matches
  // this message's id AND the message is a user text
  // bubble, the <p> swaps for a <textarea> with Save
  // / Cancel. Click on the bubble (when not editing)
  // fires onEditMessage. The Message component owns a
  // local textarea mirror; editing state never round-trips
  // through the parent (the earlier write-only
  // `editingDraft` / `onDraftChange` plumbing made every
  // keystroke re-render the whole visible timeline).
  readonly editingMessageId?: string | null;
  readonly onEditMessage?: (id: string) => void;
  // v1.16.3.2: onSaveEdit takes the new text as an
  // argument so the Message component can pass its
  // local-mirror value directly. Earlier we went through
  // editingDraft state, but the setState is async and
  // the synchronous save read the stale value — Save
  // silently bailed with !newText.
  readonly onSaveEdit?: (text: string) => void;
  readonly onCancelEdit?: () => void;
  // v1.16.5+ (M3, Work): artifact rendering plumbing.
  // `artifactHost` opens files through the host adapter;
  // `onOpenArtifact` is the in-app viewer hook; 
  // `workspacePath` relativises the shown path. All are
  // only read by the `artifact` case.
  readonly artifactHost?: HostAdapter;
  readonly onOpenArtifact?: (path: string) => void;
  readonly workspacePath?: string;
  // M4-E (spec §6.7 Core "approval"): the inline ApprovalCard responder.
  // 2026-09-04 (CLI 单核): the workd input-request responder retired with
  // the daemon; only the `approval` case reads this.
  readonly onRespondApproval?: import('./ApprovalCard').ApprovalCardProps['onRespond'];
  readonly onRespondInputRequest?: import('./InputRequestCard').InputRequestCardProps['onRespond'];
  // P3 (spec §3.3): open the right-side diff panel for a
  // pending approval's proposed change. The id is the stable
  // `approvalId` (Work) or `requestId` (Code). Never triggers
  // approval; the card guarantees the separation.
  readonly onOpenApprovalPreview?: (id: string) => void;
  readonly onCognitionAnswer?: (id: string, text: string) => void;
  readonly onCognitionDismiss?: (id: string, kind: 'dismiss' | 'not_now' | 'snooze' | 'dont_ask_similar') => void;
  readonly onLearningImpactResolve?: (id: string, acceptPersonalization: boolean) => void;
  // 2026-08-28 (Work chat-mode split): accept the suggestion
  // chip — re-send the suggestion's text as an explicit task.
  // 2026-08-29 fix: pass id so host can dismiss the chip and
  // avoid duplicating the user bubble in chat.
  readonly onRunTaskSuggestion?: (text: string, id: string) => void;
  /** PR-3 遗留收口: promote a conversation runtime artifact into
   *  `.trylo/out` from a ToolCard. Work-only (only Work runs tool
   *  Profiles); the host binds the visible Work conversation scope. */
  readonly onPromoteRuntimeArtifact?: (
    packageId: string,
    fileName: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

/** Compact byte string for the sent-attachment file chips. */
function formatSentBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function MessageImpl(props: MessageProps): ReactElement {
  const m = props.message;
  // v1.16.3: hooks live at the TOP so every render
  // calls them in the same order regardless of which
  // switch case fires. Putting them in a case branch
  // is a Rules-of-Hooks violation that crashes React
  // (the message stops rendering, edit clicks do
  // nothing, thinking may appear in the wrong order).
  const isUser = m.kind === 'text' && m.role === 'user';
  const editing =
    isUser &&
    props.editingMessageId === m.id &&
    typeof props.onEditMessage === 'function' &&
    typeof props.onSaveEdit === 'function' &&
    typeof props.onCancelEdit === 'function';
  const canEdit = isUser && !editing && typeof props.onEditMessage === 'function';
  // Local mirror so the user's typing isn't fighting a
  // parent re-render. We re-seed when editingMessageId
  // changes so the textarea picks up the new message.
  const [draft, setDraft] = useState<string>(
    m.kind === 'text' ? m.text : '',
  );
  useEffect(() => {
    if (editing && m.kind === 'text') {
      setDraft(m.text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.editingMessageId]);

  switch (m.kind) {
    // 2026-09-10 (applyWorkItem deletion面): `case 'workflow'` deleted with
    // the WorkflowMessage chain — the mapper/reducer were its only producers
    // and both are gone, so no producer exists in production or history.
    case 'work_rail': {
      // 2026-08-29 (linear Work UI, spec §4). MessageList
      // routes the four linear kinds to their dedicated
      // components before reaching here; these branches
      // are the safety nets mirroring 'workflow' above.
      return <WorkPhaseRail key={m.id} message={m} />;
    }
    case 'work_narration': {
      return <WorkNarration key={m.id} message={m} />;
    }
    case 'deliverable': {
      return <DeliverableProgressPanel key={m.id} message={m} />;
    }
    case 'text': {
      return (
        <div
          className={`message message--${isUser ? 'user' : 'assistant'}`}
          role="listitem"
        >
          <div className="message__col">
            <div
              className={`message__bubble${editing ? ' message__bubble--editing' : ''}`}
              onClick={
                canEdit
                  ? () => props.onEditMessage!(m.id)
                  : undefined
              }
              onKeyDown={canEdit ? event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                props.onEditMessage!(m.id);
              } : undefined}
              role={canEdit ? 'button' : undefined}
              tabIndex={canEdit ? 0 : undefined}
              style={canEdit ? { cursor: 'text' } : undefined}
              title={canEdit ? '编辑消息' : undefined}
            >
              {editing ? (
                <div className="message__edit">
                  <textarea
                    className="message__edit-area"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    autoFocus
                    rows={Math.max(3, draft.split('\n').length)}
                  />
                  <div className="message__edit-actions">
                    <button
                      type="button"
                      className="message__edit-save"
                      onClick={() => {
                        props.onSaveEdit!(draft);
                      }}
                    >
                      Save & re-send
                    </button>
                    <button
                      type="button"
                      className="message__edit-cancel"
                      onClick={() => props.onCancelEdit!()}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : isUser ? (
                <div className="message__user-content">
                  {m.attachments && m.attachments.length > 0 && (
                    <div className="message__attachments">
                      {m.attachments.map((att) => (
                        <span
                          key={att.id}
                          className={`message__attachment message__attachment--${att.kind}`}
                          title={att.name}
                        >
                          {att.kind === 'image' && att.previewUrl ? (
                            <img
                              className="message__attachment-img"
                              src={att.previewUrl}
                              alt={att.name}
                            />
                          ) : (
                            <>
                              <span className="message__attachment-name">{att.name}</span>
                              {typeof att.size === 'number' && (
                                <span className="message__attachment-size">
                                  {formatSentBytes(att.size)}
                                </span>
                              )}
                            </>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="message__text">{m.text}</p>
                  {/* Round-3 (P0-5): a mid-run guidance stays VISIBLE but stops
                      pretending to be a normal user turn. Excluded from the
                      turn boundary and from turnCount (see message-identity /
                      conversation-history), and flagged here so a person
                      reading this transcript later can tell a guidance apart
                      from a real turn — and see that this one never landed. */}
                  {m.steerState !== undefined && (
                    <span
                      className={`message__steer-flag message__steer-flag--${m.steerState}`}
                      data-steer-state={m.steerState}
                      title={
                        m.steerState === 'delivered'
                          ? '这条引导已送入运行中的任务，不计入轮次'
                          : '这条引导未送达，且不计入轮次'
                      }
                    >
                      {m.steerState === 'delivered' ? '↑ 已送入运行中的任务' : '× 引导未送达'}
                    </span>
                  )}
                </div>
              ) : (
                <AssistantAnswer text={m.text} onOpenArtifact={props.onOpenArtifact} artifactHost={props.artifactHost} />
              )}
            </div>

          </div>
        </div>
      );
    }
    case 'tool': {
      // File-mutating tools get the IDE-style change card (project name +
      // green +N / red -N + line diff); everything else uses ToolCard.
      // Fall back to ToolCard when the input shape isn't recognised so no
      // tool call ever renders blank.
      if (computeFileChanges(m.tool, m.input, m.outputContent).length > 0) {
        return (
          <FileChangeCards
              variant="event"
            key={m.id}
            message={m}
            workspacePath={props.workspacePath}
            onOpenFile={props.onOpenArtifact}
          />
        );
      }
      return <ToolCard variant="event" key={m.id} message={m} workspacePath={props.workspacePath} {...(props.onPromoteRuntimeArtifact ? { onPromoteRuntimeArtifact: props.onPromoteRuntimeArtifact } : {})} />;
    }
    case 'thinking': {
      return (
        <ThinkingCard
          key={m.id}
          message={m}
          turnStartedAt={props.turnStartedAt ?? null}
          finalElapsedMs={props.finalElapsedMs}
          isTurnActive={props.isTurnActive === true}
          isFirstInTurn={props.isFirstInTurn === true}
        />
      );
    }
    case 'turn': {
      // 2026-09-03: the "Turn N" divider was noise during a long running
      // workflow (each turn_start row). Keep the turn record in state so
      // ProcessHeader stats still count turns; render nothing.
      //
      // Round-3 (P1-11) EXCEPTION: a turn that delivered nothing says so.
      // Before this, a failed 0-token turn was indistinguishable from a
      // finished one — the composer returned to idle and the transcript
      // simply stopped, which reads as "still working" or "all good".
      //
      // P1-11 follow-up: a FAILED turn with a partial answer must not look
      // done either (three failed turns that all render nothing read as
      // three successes). The marker wording differs —「未完成」when no
      // answer exists,「运行失败/触顶截断」when one does — but no failed
      // turn is ever invisible.
      if (m.incomplete !== true && m.status !== 'error') return <></>;
      const label = m.incomplete === true
        ? '本轮未完成'
        : m.stopReason === 'max_tokens' ? '本轮输出触顶截断' : '本轮运行失败';
      return (
        <div className="message message--turn-incomplete" role="listitem">
          <span className="message__turn-incomplete" data-turn-incomplete="true">
            <CircleAlert size={13} strokeWidth={1.7} aria-hidden="true" />
            {label}
            {m.stopReason === 'failed' ? ' · 运行未成功结束' : ''}
          </span>
        </div>
      );
    }
    case 'compaction': {
      return <CompactionCard key={m.id} message={m} />;
    }
    case 'artifact': {
      const kind = resolveArtifactKind(m.artifactKind, m.filePath);
      // §9.2 (M3-P2-07): segment-boundary relative
      // computation on canonicalized paths — the old
      // case-sensitive startsWith mis-handled drive
      // casing and sibling roots like `D:\repo2`.
      const relative = relativeArtifactPath(m.filePath, props.workspacePath) ?? m.filePath;
      return (
        <div className="message message--artifact" role="listitem">
          <ArtifactCard
            filePath={m.filePath}
            kind={kind}
            workspacePath={props.workspacePath}
            host={props.artifactHost}
            onOpenViewer={
              props.onOpenArtifact
                ? (path) => props.onOpenArtifact?.(path)
                : undefined
            }
          />
          <div className="message__artifact-meta">
            <span className="message__artifact-path" title={m.filePath}>
              {relative}
            </span>
            <span className="message__artifact-state">
              {m.updated === true ? 'updated' : 'generated'}
            </span>
          </div>
        </div>
      );
    }
    case 'error': {
      return <ErrorCard key={m.id} message={m} />;
    }
    case 'task_suggestion': {
      // 2026-08-28 (Work chat-mode split): the DEFAULT send
      // is a conversation message. When the text reads like a
      // work order, this chip offers the one-click upgrade —
      // clicking re-sends the SAME text as an explicit task
      // (tools + deliverables allowed). Pure renderer state;
      // nothing reached the daemon until now.
      return (
        <div className="message message--task-suggestion" role="listitem">
          <div className="task-suggestion">
            <span className="task-suggestion__label">
              这看起来像一个任务
            </span>
            <button
              type="button"
              className="task-suggestion__run"
              onClick={() => props.onRunTaskSuggestion?.(m.text, m.id)}
            >
              <Rocket size={12} strokeWidth={2.2} aria-hidden="true" />
              以任务运行
            </button>
          </div>
        </div>
      );
    }
    case 'approval': {
      return <ApprovalMessageRow key={m.id} message={m}
        onRespond={props.onRespondApproval} onOpenPreview={props.onOpenApprovalPreview} />;
    }
    case 'input_request': {
      // Questions are presented above the composer by the conversation surface.
      return <></>;
    }
    case 'cognition_prompt': {
      return (
        <div className="message message--cognition" role="listitem">
          <CognitionPromptCard
            message={m}
            onAnswer={props.onCognitionAnswer}
            onDismiss={props.onCognitionDismiss}
          />
        </div>
      );
    }
    case 'learning_impact': {
      return (
        <div className="message message--cognition" role="listitem">
          <LearningImpactCard
            message={m}
            onResolve={props.onLearningImpactResolve}
          />
        </div>
      );
    }
    case 'goal': return <></>; // The persistent goal is displayed beside the composer.
    case 'notice': {
      if (isWorkflowState(m.workflow)) return <div className="message message--notice" role="listitem"><WorkflowReceipt workflow={m.workflow} /></div>;
      if (!m.text.trim()) return <></>;
      const compactNotice = compactionNoticePresentation(m.text);
      if (compactNotice) return <CompactionCard {...compactNotice} />;
      // Bookkeeping events that events.ts still routes here
      // render as a small status line.
      return (
        <div className="message message--notice" role="listitem">
          <RuntimeNotice text={m.text} />
        </div>
      );
    }
    case 'subagent':
      // §8.1: subagent lifecycle (incl. managed-work children) gets a card
      // with status badge + expandable detail drawer.
      return (
        <div className="message message--subagent" role="listitem">
          <SubagentCard message={m} />
        </div>
      );
  }
  // 2026-09-10 (applyWorkItem deletion面): exhaustive-switch fallback. The
  // union above covers every producible kind; a stale persisted row of a
  // retired kind (e.g. `workflow`) renders nothing instead of crashing.
  return <></>;
}

// Memoized: applyEvents replaces only the message objects that actually
// changed and App binds handlers with useCallback, so a streaming delta
// re-renders just the growing row instead of every visible card. This is
// the single biggest lever on scroll jank while a workflow is running.
export const Message = memo(MessageImpl);
Message.displayName = 'Message';
