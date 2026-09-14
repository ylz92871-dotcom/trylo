// Trylo Desktop — Message. See spike-results/phase-2-ui-redesign.md.
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
//   compaction        → CompactionCard (small pill)
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
// v1.16.4.1: <TurnProgress /> moved OUT of ThinkingCard
// and INTO the user message row, right after the
// user bubble. Reason: the timer must appear the MOMENT
// the user sends — before any thinking event arrives —
// and it must keep appearing even if the model produces
// NO thinking for the turn (text-only models, very
// short replies). Putting it in ThinkingCard meant
// "no thinking card → no timer" which is exactly the
// "用户一发消息，计时UI 不出现" symptom. The new
// layout: user bubble + a small TurnProgress row
// underneath, both reading from the user message's
// own `turnStartedAt` / `finalElapsedMs` / isActive.

import { memo, useEffect, useState, type ReactElement } from 'react';
import { Rocket } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { ChatMessage } from './types';
import { ToolCard } from './ToolCard';
import { FileChangeCard } from './FileChangeCard';
import { computeFileChange, fileChangeTool } from './file-change';
import { ThinkingCard } from './ThinkingCard';
import { CompactionCard } from './CompactionCard';
import { TurnProgress } from './TurnProgress';
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
import { ApprovalCard } from './ApprovalCard';
import { InputRequestCard } from './InputRequestCard';
import { CognitionPromptCard } from '../user-learning/CognitionPromptCard';
import { LearningImpactCard } from '../user-learning/LearningImpactCard';
import { SubagentCard } from './SubagentCard';
// v1.16.5+ (M3): Work capability renders inline through
// the SAME card the Work sub-app ships — no second
// artifact component.
import { ArtifactCard, relativeArtifactPath, type HostAdapter } from '@trylo/work';
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
  readonly onRespondApproval?: (approvalId: string, approved: boolean) => void;
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

const FILE_MENTION = /^(?:[a-z]:[\\/]|\.?\.?[\\/])?[^\n`<>]+\.(?:md|txt|json|ya?ml|toml|tsx?|jsx?|css|html?|py|rs|go|java|c|cpp|h|hpp|pptx?|xlsx?|docx?|pdf|csv|svg|png|jpe?g|webp|gif)$/i;

/** Compact byte string for the sent-attachment file chips. */
function formatSentBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// Memoized: ReactMarkdown re-parses the full text on every render, so an
// unchanged message must never re-run it (streaming deltas re-render the
// timeline many times per second).
const AssistantAnswer = memo(function AssistantAnswer(props: {
  readonly text: string;
  readonly onOpenArtifact?: (path: string) => void;
}): ReactElement {
  return (
    <div className="message__text message__text--markdown">
      <ReactMarkdown
        components={{
          code: ({ children }) => {
            const value = String(children).replace(/\n$/, '').trim();
            if (props.onOpenArtifact && FILE_MENTION.test(value)) {
              return (
                <button
                  type="button"
                  className="message__artifact-link"
                  onClick={() => props.onOpenArtifact?.(value.replace(/\\/g, '/'))}
                  title={`在右侧打开 ${value}`}
                >
                  {value}
                </button>
              );
            }
            return <code>{children}</code>;
          },
        }}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  );
});

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
      const showTurnTimer =
        isUser &&
        (props.turnStartedAt !== null && props.turnStartedAt !== undefined);
      return (
        <div
          className={`message message--${isUser ? 'user' : 'assistant'}`}
          role="listitem"
        >
          <div className="message__col">
            <div
              className={`message__bubble${editing ? ' message__bubble--editing' : ''}`}
              onClick={
                isUser && !editing && props.onEditMessage
                  ? () => props.onEditMessage!(m.id)
                  : undefined
              }
              style={isUser && !editing ? { cursor: 'text' } : undefined}
              title={isUser && !editing ? 'Click to edit' : undefined}
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
                </div>
              ) : (
                <AssistantAnswer text={m.text} onOpenArtifact={props.onOpenArtifact} />
              )}
            </div>
            {/* v1.16.4.1: TurnProgress lives on the
                user message row, NOT inside ThinkingCard.
                This is the single visible "the model is
                working" indicator for the turn. It reads
                turnStartedAt + finalElapsedMs + isActive
                from this very user message and freezes on
                the first non-empty thinking/text event
                (see events.ts `freezeTurnTimer`). It
                appears the MOMENT the user sends — even
                before the first thinking event arrives,
                even on text-only models. When the user
                edits a past message, the user message
                re-stamps turnStartedAt and the timer
                re-appears for the new turn. */}
            {showTurnTimer && (
              <TurnProgress
                turnStartedAt={props.turnStartedAt ?? null}
                finalElapsedMs={props.finalElapsedMs}
                isActive={props.isTurnActive === true}
              />
            )}
          </div>
        </div>
      );
    }
    case 'tool': {
      // File-mutating tools get the IDE-style change card (project name +
      // green +N / red -N + line diff); everything else uses ToolCard.
      // Fall back to ToolCard when the input shape isn't recognised so no
      // tool call ever renders blank.
      if (fileChangeTool(m.tool) !== null && computeFileChange(m.tool, m.input) !== null) {
        return (
          <FileChangeCard
            key={m.id}
            message={m}
            workspacePath={props.workspacePath}
          />
        );
      }
      return <ToolCard key={m.id} message={m} {...(props.onPromoteRuntimeArtifact ? { onPromoteRuntimeArtifact: props.onPromoteRuntimeArtifact } : {})} />;
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
      return <></>;
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
      return (
        <div className="message message--approval" role="listitem">
          <ApprovalCard
            key={m.id}
            message={m}
            onRespond={props.onRespondApproval}
            onOpenPreview={props.onOpenApprovalPreview}
          />
        </div>
      );
    }
    case 'input_request': {
      // 2026-09-04 (CLI 单核): no live responder anymore — the daemon
      // input-request pipeline retired. Persisted cards render read-only.
      return (
        <div className="message message--input-request" role="listitem">
          <InputRequestCard
            key={m.id}
            message={m}
          />
        </div>
      );
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
    case 'notice':
      // Bookkeeping events that events.ts still routes here
      // render as a small status line.
      return (
        <div className="message message--notice" role="listitem">
          <span className="message__notice">
            <span className="message__role">SYSTEM</span>
            {' · '}
            {m.text}
          </span>
        </div>
      );
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
