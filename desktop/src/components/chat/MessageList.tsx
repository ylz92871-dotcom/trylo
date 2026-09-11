// Trylo Desktop — the shared virtualized conversation timeline.
//
// Code and Work share scrolling, edit controls and decision cards, but their
// workflow presentation is intentionally separate:
//   - Code projects atomic thinking/tool events into one chronological,
//     lossless reasoning transcript per contiguous run segment.
//   - Work projects run-level rail/narration/activity messages into one task
//     board, while deliverables and decisions remain first-class panels.
//
// The projection is renderer-only. Persisted messages stay atomic so replay,
// recovery and diagnostics do not depend on a UI component's local state.

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown } from 'lucide-react';
import { Message } from './Message';
import { StreamingIndicator } from './StreamingIndicator';
import { WorkWorkflowCard } from './WorkWorkflowCard';
import { DeliverableProgressPanel } from './DeliverableProgressPanel';
import {
  CodeReasoningTranscript,
  type CodeProcessEntry,
} from './CodeReasoningTranscript';
import { WorkTaskBoard } from './WorkTaskBoard';
import type {
  ChatMessage,
  TextMessage,
  WorkActivityGroupMessage,
  WorkNarrationLine,
  WorkRailMessage,
} from './types';
import {
  type ConversationRunViewState,
  deriveConversationRunViewState,
  viewStateShowsFooterDots,
} from './view-state';

export interface MessageListProps {
  readonly messages: readonly ChatMessage[];
  /** Code and Work share one scroll/composer shell, but deliberately use
   * different workflow projections inside it. */
  readonly surface?: 'code' | 'work';
  /** v1.15.8.b: pass the active turn so we can render
   *  a streaming indicator at the bottom when the user
   *  sent a message and is still waiting on the model. */
  readonly running?: boolean;
  /** v1.16.5+ (spec §5.3): the shared visible run state,
   *  the single driver of the footer indicator. When
   *  omitted (standalone / tests) it is derived from
   *  `running` + messages. */
  readonly viewState?: ConversationRunViewState;
  // v1.16.3: inline-edit of past user messages. When
  // editingMessageId matches a user message, Message
  // swaps that message's <p> for a <textarea> + Save /
  // Cancel. The MessageList just passes these through;
  // the matching Message component reads them.
  readonly editingMessageId?: string | null;
  readonly editingDraft?: string;
  readonly onEditMessage?: (id: string) => void;
  readonly onSaveEdit?: (text: string) => void;
  readonly onCancelEdit?: () => void;
  readonly onDraftChange?: (id: string, text: string) => void;
  // v1.16.5+ (M3, Work): forwarded to Message for inline
  // ArtifactCard rendering. Unused by Code conversations.
  readonly artifactHost?: import('@trylo/work').HostAdapter;
  readonly onOpenArtifact?: (path: string) => void;
  readonly workspacePath?: string;
  // M4-E (spec §6.7 Core "approval / input"): forwarded to
  // Message for the inline ApprovalCard / InputRequestCard
  // responders. Unused by Code conversations.
  readonly onRespondApproval?: (approvalId: string, approved: boolean) => void;
  // P3 (spec §3.3): open the right-side diff panel for a
  // pending approval's proposed change. The id is the
  // stable `approvalId` (Work) or `requestId` (Code).
  readonly onOpenApprovalPreview?: (id: string) => void;
  // 2026-08-28 (Work chat-mode split): the task-suggestion
  // chip's accept action. Unused by Code conversations.
  // 2026-08-29 fix: id lets host dismiss the chip without duplicating bubble.
  readonly onRunTaskSuggestion?: (text: string, id: string) => void;
  /** PR-3 遗留收口: forwarded to Message → ToolCard for the runtime-artifact
   *  promote affordance. Work-only; undefined on Code keeps cards clean. */
  readonly onPromoteRuntimeArtifact?: (
    packageId: string,
    fileName: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  readonly onCognitionAnswer?: (id: string, text: string) => void;
  readonly onCognitionDismiss?: (id: string, kind: 'dismiss' | 'not_now' | 'snooze' | 'dont_ask_similar') => void;
  readonly onLearningImpactResolve?: (id: string, acceptPersonalization: boolean) => void;
}

type CodeProcessItem = {
  readonly kind: '__code_process';
  readonly key: string;
  readonly turnId: string;
  readonly phaseId: string;
  readonly entries: readonly CodeProcessEntry[];
  readonly active: boolean;
};

type WorkProcessItem = {
  readonly kind: '__work_process';
  readonly key: string;
  readonly turnId: string;
  readonly rail: WorkRailMessage;
  readonly narrations: readonly WorkNarrationLine[];
  readonly activity?: WorkActivityGroupMessage;
  readonly taskTitle?: string;
};

type ListItem = ChatMessage | CodeProcessItem | WorkProcessItem;

function isCodeProcessItem(item: ListItem): item is CodeProcessItem {
  return item.kind === '__code_process';
}

function isWorkProcessItem(item: ListItem): item is WorkProcessItem {
  return item.kind === '__work_process';
}

function isSyntheticItem(item: ListItem): item is CodeProcessItem | WorkProcessItem {
  return isCodeProcessItem(item) || isWorkProcessItem(item);
}

// v1.16.4: per-turn metadata the parent computes once
// per render and passes to each Message via lookup.
// Holding the user message (not just the fields) means
// MessageList can read finalElapsedMs and isTurnActive
// without re-deriving them per child.
interface TurnMeta {
  readonly userMessage: TextMessage;
  readonly isActive: boolean;
}

export function MessageList(props: MessageListProps): ReactElement {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // ── Mature auto-scroll (Cursor / VS Code / Cline pattern)
  // ╭────────────────────────────────────────────────────────────────╮
  // │ Follow-state is a *ref*, not state — it's observation, not    │
  // │ render data. Three signals drive it:                          │
  // │                                                                │
  // │ 1. atBottomStateChange from Virtuoso (truthful at-bottom     │
  // │    detection — better than reading scrollHeight).            │
  // │ 2. wheel / keyboard scroll-up on the list window — the user  │
  // │    wants to read history, so we stop following immediately.  │
  // │ 3. A new user message — clicking Send is an explicit "follow │
  // │    along again" signal, so we re-arm following.              │
  // │                                                                │
  // │ When the ref is true → we keep the list anchored to the      │
  // │ bottom (smooth scroll on new items). When it's false → we    │
  // │ let the user scroll freely and only surface the small       │
  // │ "follow tail" pill.                                          │
  // ╰────────────────────────────────────────────────────────────────╯
  const followRef = useRef(true);
  // Mirror in state so the "follow tail" pill can render (purely
  // visual). The ref is the source of truth.
  const [atBottom, setAtBottom] = useState(true);
  // Updated by the wheel / keydown listener; throttled to once per
  // ~120ms so a fast scroll doesn't spam updates.
  const lastWheelRef = useRef(0);

  const showScrollBtn = !atBottom && props.messages.length > 0;
  const running = props.running === true;

  // v1.16.5+ (spec §5.3): the footer indicator is driven by
  // the shared view state, not by `running`. The three-dot
  // footer is the thinking primary (§7.2); it shows only
  // while the state is 'thinking' — never as a second loop
  // next to TurnProgress (waiting_first_output) or the Tool
  // loader (tool_running).
  const viewState =
    props.viewState ??
    deriveConversationRunViewState({
      messages: props.messages,
      running,
    });
  const showStreamingFooter = viewStateShowsFooterDots(viewState);

  // v1.16.4: per-turn metadata. Walk messages once and
  // build a `userMessage.id → TurnMeta` map. The active
  // turn is "the last user message in the chat AND
  // running is true". Earlier turns are always
  // inactive. We keep the user message itself (not just
  // the timer fields) so children can read
  // `finalElapsedMs` without us re-deriving.
  const turnMetaByTurnId = useMemo<Map<string, TurnMeta>>(() => {
    const out = new Map<string, TurnMeta>();
    let lastUserMsg: TextMessage | null = null;
    for (let i = props.messages.length - 1; i >= 0; i--) {
      const m = props.messages[i];
      if (m && m.kind === 'text' && m.role === 'user') {
        lastUserMsg = m;
        break;
      }
    }
    // Walk forward so we can collect EVERY user message
    // and assign isActive only to the last one if
    // running.
    let currentUser: TextMessage | null = null;
    for (let i = 0; i < props.messages.length; i++) {
      const m = props.messages[i];
      if (!m) continue;
      if (m.kind === 'text' && m.role === 'user') {
        currentUser = m;
        // We don't know yet if THIS one is the last user
        // message; defer the isActive assignment below.
        out.set(m.id, {
          userMessage: m,
          isActive: false, // patched below if it's the last
        });
      } else if (currentUser) {
        // Non-user messages inherit the current turn's
        // meta. Some events don't carry a turnId (legacy
        // / pre-v1.16.4 fixtures); the index-based
        // fallback is `currentUser` (the most recent
        // user message in the array).
        const turnId = m.turnId ?? currentUser.id;
        if (!out.has(turnId)) {
          out.set(turnId, {
            userMessage: currentUser,
            isActive: false,
          });
        }
      }
    }
    // Mark the last user message as active if running.
    if (lastUserMsg && running) {
      const existing = out.get(lastUserMsg.id);
      if (existing) {
        out.set(lastUserMsg.id, { ...existing, isActive: true });
      }
    }
    return out;
  }, [props.messages, running]);

  // Transport events are projected differently for the two products:
  // Code becomes a chronological reasoning transcript; Work becomes a
  // run-level task board. The scroll shell is shared, the workflow grammar is
  // not. This is intentionally a view projection only — persisted messages
  // remain lossless and independently replayable.
  const items = useMemo<readonly ListItem[]>(() => {
    const result: ListItem[] = [];
    let currentTurn: { turnId: string; msgs: ChatMessage[] } | null = null;

    const flushTurn = (): void => {
      if (!currentTurn) return;
      const turnMsgs = currentTurn.msgs;
      if ((props.surface ?? 'code') === 'code') {
        type PhaseGroup = {
          firstIndex: number;
          lastIndex: number;
          phaseId: string;
          entries: CodeProcessEntry[];
        };
        const phases: PhaseGroup[] = [];
        const phaseAtIndex = new Map<number, PhaseGroup>();
        let fallbackPhase = 0;
        let previousProcess: PhaseGroup | undefined;
        for (let index = 0; index < turnMsgs.length; index += 1) {
          const message = turnMsgs[index];
          if (!message || (message.kind !== 'thinking' && message.kind !== 'tool')) {
            previousProcess = undefined;
            continue;
          }
          const phaseId = message.phaseId ?? previousProcess?.phaseId ?? `legacy-${fallbackPhase}`;
          let phase = previousProcess?.phaseId === phaseId ? previousProcess : undefined;
          if (!phase) {
            phase = { firstIndex: index, lastIndex: index, phaseId, entries: [] };
            phases.push(phase);
            phaseAtIndex.set(index, phase);
            fallbackPhase += 1;
          }
          phase.lastIndex = index;
          phase.entries.push(message);
          previousProcess = phase;
        }
        const lastPhase = phases.at(-1);
        const hasAssistantOutputAfter = (phase: PhaseGroup): boolean => (
          turnMsgs.slice(phase.lastIndex + 1).some((message) => (
            message.kind === 'text' && message.role === 'assistant'
          ))
        );
        for (let index = 0; index < turnMsgs.length; index += 1) {
          const message = turnMsgs[index];
          if (!message) continue;
          const phase = phaseAtIndex.get(index);
          if (phase) {
            const isCurrentPhase = phase === lastPhase && !hasAssistantOutputAfter(phase);
            result.push({
              kind: '__code_process',
              key: `code-process:${currentTurn.turnId}:${phase.phaseId}`,
              turnId: currentTurn.turnId,
              phaseId: phase.phaseId,
              entries: phase.entries,
              active: turnMetaByTurnId.get(currentTurn.turnId)?.isActive === true && isCurrentPhase,
            });
          }
          if (message.kind !== 'thinking' && message.kind !== 'tool') {
            result.push(message);
          }
        }
      } else {
        const taskTitle = turnMsgs.find(
          (entry): entry is TextMessage => entry.kind === 'text' && entry.role === 'user',
        )?.text;
        type WorkRun = {
          firstIndex: number;
          rail?: WorkRailMessage;
          narrations: WorkNarrationLine[];
          activity?: WorkActivityGroupMessage;
        };
        const runs = new Map<string, WorkRun>();
        // 2026-09-04 (align to Code): Work tool/thinking are grouped PER PHASE
        // into collapsed transcripts, each inserted at its phase's FIRST
        // thinking/tool — exactly how Code interleaves reasoning with narrative
        // text, so the turn reads chronologically and the final answer lands last.
        type WPhase = { phaseId: string; firstIndex: number; entries: import('./CodeReasoningTranscript').CodeProcessEntry[] };
        const wPhases: WPhase[] = [];
        const wPhaseAtIndex = new Map<number, WPhase>();
        let prevProc: WPhase | undefined;
        let fallbackW = 0;
        for (let i = 0; i < turnMsgs.length; i += 1) {
          const m = turnMsgs[i];
          if (!m || (m.kind !== 'thinking' && m.kind !== 'tool')) { prevProc = undefined; continue; }
          const phaseId = m.phaseId ?? prevProc?.phaseId ?? `legacy-${fallbackW}`;
          let ph = prevProc && prevProc.phaseId === phaseId ? prevProc : undefined;
          if (!ph) {
            ph = { phaseId, firstIndex: i, entries: [] };
            wPhases.push(ph);
            wPhaseAtIndex.set(i, ph);
            fallbackW += 1;
          }
          ph.entries.push(m);
          prevProc = ph;
        }
        for (let index = 0; index < turnMsgs.length; index += 1) {
          const message = turnMsgs[index];
          if (!message) continue;
          if (
            message.kind !== 'work_rail'
            && message.kind !== 'work_narration'
            && message.kind !== 'work_activity_group'
          ) continue;
          const runId = message.runId;
          const run = runs.get(runId) ?? { firstIndex: index, narrations: [] };
          run.firstIndex = Math.min(run.firstIndex, index);
          if (message.kind === 'work_rail') run.rail = message;
          if (message.kind === 'work_narration') run.narrations.push(message);
          if (message.kind === 'work_activity_group') run.activity = message;
          runs.set(runId, run);
        }
        for (let index = 0; index < turnMsgs.length; index += 1) {
          const message = turnMsgs[index];
          if (!message) continue;
          if (
            message.kind === 'work_rail'
            || message.kind === 'work_narration'
            || message.kind === 'work_activity_group'
          ) {
            const run = runs.get(message.runId);
            if (run?.rail && run.firstIndex === index) {
              result.push({
                kind: '__work_process',
                key: `work-process:${message.runId}`,
                turnId: currentTurn.turnId,
                rail: run.rail,
                narrations: run.narrations.sort((a, b) => a.createdAt - b.createdAt),
                ...(taskTitle ? { taskTitle } : {}),
                ...(run.activity ? { activity: run.activity } : {}),
              });
            } else if (!run?.rail) {
              // Incomplete legacy projections stay visible rather than being
              // swallowed while the rail snapshot catches up.
              result.push(message);
            }
            continue;
          }
          const wphase = wPhaseAtIndex.get(index);
          if (wphase) {
            // Fold the Work tool/thinking transcript per phase: it stays open
            // only while the turn is live AND this phase still has a
            // running/pending tool. Once the phase's tools complete it collapses
            // (green ✓) rather than staying expanded+spinning until the entire
            // task finishes. Whole-task end (`running` false) also collapses it.
            const phaseHasActiveTool = wphase.entries.some(
              (e): boolean => e.kind === 'tool' && (e.status === 'running' || e.status === 'pending'),
            );
            result.push({
              kind: '__code_process',
              key: `code-process:${currentTurn.turnId}:${wphase.phaseId}`,
              turnId: currentTurn.turnId,
              phaseId: wphase.phaseId,
              entries: wphase.entries,
              active: props.running === true && phaseHasActiveTool,
            });
            continue;
          }
          if (message.kind === 'tool' || message.kind === 'thinking') continue;
          result.push(message);
        }
      }
      currentTurn = null;
    };

    for (const m of props.messages) {
      if (m.kind === 'text' && m.role === 'user') {
        // New turn — flush the previous one first.
        flushTurn();
        currentTurn = { turnId: m.id, msgs: [m] };
        continue;
      }
      if (!currentTurn) {
        // Stray message before any user message — keep
        // as-is in its own implicit turn.
        result.push(m);
        continue;
      }
      currentTurn.msgs.push(m);
    }
    flushTurn();
    return result;
  }, [props.messages, props.surface, turnMetaByTurnId]);

  // v1.15.9.j → v1.18 (2026-09-06): when the user sends a NEW message,
  // reset to follow mode. Sending is the explicit "follow along
  // again" signal — even if the user had been scrolled up reading
  // the previous turn, the new turn is theirs and they want to watch
  // it unfold. After that, any wheel / keyboard scroll up disables
  // follow again, until they re-arm it by sending OR by clicking the
  // follow-tail pill (which scrolls to bottom AND re-arms follow).

  // Refs that survive across renders without re-triggering them.
  const lastUserMsgIdRef = useRef<string | null>(null);

  // When items change (a new user turn lands, or streaming content
  // grows), auto-scroll ONLY if we're still in follow mode.
  //
  // This is the single scroll driver — see the followOutput={false}
  // note on the <Virtuoso> for why there must be only one.
  useEffect(() => {
    let shouldScroll = false;

    // Find the bottom-most user message id; if it's new, the user
    // just sent something → re-arm follow mode and scroll.
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const m = items[i];
      if (!m || isSyntheticItem(m)) continue;
      if (m.kind === 'text' && m.role === 'user') {
        if (m.id !== lastUserMsgIdRef.current) {
          lastUserMsgIdRef.current = m.id;
          followRef.current = true;
          shouldScroll = true;
        }
        break;
      }
    }
    // Streaming / synthetic item growth: stay anchored when armed.
    if (followRef.current) shouldScroll = true;

    if (!shouldScroll) return;

    // Guard the setState so a burst of stream deltas (each producing a
    // new `items` identity) doesn't schedule a render per delta. The
    // functional form lets React bail out when the value is unchanged.
    setAtBottom(true);
    virtuosoRef.current?.scrollToIndex({
      index: items.length - 1,
      align: 'end',
      // 'auto' (instant) during a live run: dozens of smooth animations
      // back-to-back fight the user's own scrolling and make the tail
      // feel laggy. 'smooth' is reserved for the explicit pill click.
      behavior: 'auto',
    });
  }, [items]);

  // Wheel / keydown listener — the user explicitly scrolled up, so we
  // disarm follow mode. Cline/VSC implement this with a window-level
  // listener; we listen at window level too because the virtualized
  // list may not always have a stable DOM target.
  useEffect(() => {
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY >= 0) return; // only disarm on upward scroll
      const now = performance.now();
      // Throttle: ignore follow-up wheels within 120ms — they fire
      // dozens per second on a trackpad and don't carry new intent.
      if (now - lastWheelRef.current < 120) return;
      lastWheelRef.current = now;
      // Verify the wheel happened inside the message list (cheaper
      // heuristic: any element has `data-message-list-root` set
      // below, since the user only cares about disarming when the
      // scroll WAS the message list).
      const path = e.composedPath();
      const insideList = path.some((node) =>
        node instanceof Element && node.closest('[data-message-list-root]'),
      );
      if (!insideList) return;
      if (followRef.current) {
        followRef.current = false;
        // Guarded: only re-render when the pill actually needs to
        // appear, so a trackpad fling costs at most one update.
        setAtBottom((prev) => (prev ? false : prev));
      }
    };
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  // Keyboard PageUp / ArrowUp — same disarming intent as wheel-up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Only disarm for actions that scroll *up*. PageDown / End /
      // ArrowDown re-arm follow (the user is actively chasing the
      // bottom). We don't fight other lists' key handlers.
      if (e.key !== 'PageUp' && e.key !== 'ArrowUp') return;
      const target = e.target;
      if (target instanceof Element && target.closest('input, textarea')) return;
      if (followRef.current) {
        followRef.current = false;
        setAtBottom((prev) => (prev ? false : prev));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 2026-09-06 (v1.18): auto-scroll now lives in the items-change
  // effect above, gated by `followRef`. The Virtuoso callback form
  // of `followOutput` keeps the ref in sync with Virtuoso's own
  // at-bottom view, so the two never disagree.

  return (
    <div className="message-list" data-message-list-root="" role="list" aria-label="Chat">
      <Virtuoso
        ref={virtuosoRef}
        style={{ height: '100%' }}
        data={items}
        itemContent={(_index, item) => {
          if (isCodeProcessItem(item)) {
            const meta = turnMetaByTurnId.get(item.turnId);
            return (
              <CodeReasoningTranscript
                key={item.key}
                entries={item.entries}
                turnId={item.turnId}
                phaseId={item.phaseId}
                active={item.active && meta?.isActive === true}
              />
            );
          }
          if (isWorkProcessItem(item)) {
            return (
              <WorkTaskBoard
                key={item.key}
                rail={item.rail}
                narrations={item.narrations}
                taskTitle={item.taskTitle}
                {...(item.activity ? { activity: item.activity } : {})}
              />
            );
          }
          // Recovered legacy Work runs may still carry the older hierarchy
          // projection. Keep its dedicated renderer for history compatibility.
          if (item.kind === 'workflow') {
            return <WorkWorkflowCard key={item.id} message={item} />;
          }
          // A partial legacy Work projection without a rail is deliberately
          // not hidden. Message owns the safe fallback for these rare rows.
          if (item.kind === 'deliverable') {
            return <DeliverableProgressPanel key={item.id} message={item} />;
          }
          // v1.16.4: per-turn timer lookup. For each
          // message, find the turn meta by turnId (or
          // fall back to "this message's own id if it's
          // a user message" so the user bubble reads
          // its own timer — even though the user
          // message itself doesn't render a
          // TurnProgress, this keeps the props type
          // uniform).
          const turnId = item.turnId
            ?? (item.kind === 'text' && item.role === 'user' ? item.id : undefined);
          const meta = turnId ? turnMetaByTurnId.get(turnId) : undefined;
          return (
            <Message
              key={item.id}
              message={item}
              turnStartedAt={meta?.userMessage.turnStartedAt ?? null}
              finalElapsedMs={meta?.userMessage.finalElapsedMs}
              isTurnActive={meta?.isActive === true}
              // v1.16.3: inline-edit pass-through. The Message
              // component checks editingMessageId and swaps
              // a user <p> for a <textarea> when it matches.
              editingMessageId={props.editingMessageId}
              editingDraft={props.editingDraft}
              onEditMessage={props.onEditMessage}
              onSaveEdit={props.onSaveEdit}
              onCancelEdit={props.onCancelEdit}
              onDraftChange={props.onDraftChange}
              // v1.16.5+ (M3, Work): inline artifact
              // rendering plumbing pass-through.
              artifactHost={props.artifactHost}
              onOpenArtifact={props.onOpenArtifact}
              workspacePath={props.workspacePath}
              // M4-E: inline decision responders.
              onRespondApproval={props.onRespondApproval}
              // P3 (spec §3.3): route the "查看变更" click into
              // the right-side diff panel. The card itself never
              // auto-approves; the host owns the open.
              onOpenApprovalPreview={props.onOpenApprovalPreview}
              // 2026-08-28 (Work chat-mode split): suggestion
              // chip accept.
              onRunTaskSuggestion={props.onRunTaskSuggestion}
              // PR-3 遗留收口: runtime-artifact promote affordance.
              onPromoteRuntimeArtifact={props.onPromoteRuntimeArtifact}
              onCognitionAnswer={props.onCognitionAnswer}
              onCognitionDismiss={props.onCognitionDismiss}
              onLearningImpactResolve={props.onLearningImpactResolve}
            />
          );
        }}
        // 2026-09-06 (v1.18): followOutput is DISABLED on purpose.
        //
        // The earlier attempt wired BOTH this prop and the imperative
        // scrollToIndex in the items effect above. Two scroll drivers
        // then fought each other: a smooth scroll fired
        // atBottomStateChange → setState → re-render → Virtuoso
        // re-invoked this callback → another scroll → … an infinite
        // render loop that froze the main thread (black screen).
        //
        // There is now exactly ONE scroll driver: the items-change
        // effect, gated by followRef. Virtuoso only reports geometry.
        followOutput={false}
        atBottomStateChange={(bottom) => {
          // Reporting-only. The value is mirrored to state purely so
          // the follow-tail pill can render. We deliberately do NOT
          // write followRef here — that would re-introduce the
          // feedback loop. Re-arming happens only from the three
          // explicit signals: send, pill click, and (re)mount.
          setAtBottom((prev) => (prev === bottom ? prev : bottom));
        }}
        initialTopMostItemIndex={items.length - 1}
        components={{
          // One footer owns the shared waiting indicator and scroll breathing
          // room; workflow components render only inside the item stream.
          Footer: () => (
            <div className="message-list__footer-stack">
              {showStreamingFooter && (
                <StreamingIndicator visibleState={viewState} />
              )}
              {/* v1.15.9.j: bottom spacer so the last content
               * item isn't pressed against the bottom edge
               * of the viewport. */}
              <div style={{ height: '120px' }} />
            </div>
          ),
        }}
      />
      {showScrollBtn && (
        // 2026-09-06: the trailing pill now re-arms follow mode +
        // smoothly scrolls to the bottom in one click — clicking it
        // is the third re-arm signal alongside "send a new message"
        // and wheel-down. The pill is intentionally icon-only; the
        // design note said a small icon is enough.
        <button
          type="button"
          className="message-list__scroll-btn message-list__scroll-btn--show"
          onClick={() => {
            followRef.current = true;
            setAtBottom(true);
            virtuosoRef.current?.scrollToIndex({
              index: items.length - 1,
              align: 'end',
              behavior: 'smooth',
            });
          }}
          aria-label="Follow latest"
          title="Follow latest"
        >
          <ArrowDown size={14} strokeWidth={2.4} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
