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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown } from 'lucide-react';
import { Message } from './Message';
import { StreamingIndicator } from './StreamingIndicator';
import { createFollowController } from './follow-controller';
import { VirtuosoItem } from './virtuoso-item';
// 2026-09-10 (applyWorkItem deletion面): WorkWorkflowCard deleted with the
// WorkflowMessage chain (zero production producers). The linear rail /
// narration / deliverable panels below are different kinds and stay.
import { DeliverableProgressPanel } from './DeliverableProgressPanel';
import {
  CodeReasoningTranscript,
  type CodeProcessEntry,
} from './CodeReasoningTranscript';
import type { ChatMessage, TextMessage } from './types';
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
  readonly onEditMessage?: (id: string) => void;
  readonly onSaveEdit?: (text: string) => void;
  readonly onCancelEdit?: () => void;
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

export type ListItem = ChatMessage | CodeProcessItem;

function isCodeProcessItem(item: ListItem): item is CodeProcessItem {
  return item.kind === '__code_process';
}

// The row roots (.message, .code-reasoning, .tool, …) carry vertical
// margins for inter-row spacing. Virtuoso measures each row through its
// wrapper, and the default wrapper is a plain block — the child's margins
// collapse through it, so every row measures ~10px SHORT of what the layout
// actually renders. The error accumulates per row, and Virtuoso corrects
// the scroll offset continuously while scrolling — the classic virtualized
// "reverse scroll jitter" (virtuoso.dev troubleshooting: margins are the
// most common setup error; discussion #1083 names the same cause).
// `VirtuosoItem` (components.Item) establishes a BFC on the wrapper so the
// margins are measured; see ./virtuoso-item.tsx.

/** Values the footer needs, fed through Virtuoso's `context` prop. */
export interface FooterContext {
  readonly showStreamingFooter: boolean;
  /** True while a run is live or the dots are visible — keeps the indicator
   *  slot's height so thinking↔tool_running flips don't reshape the tail. */
  readonly reserveFooterSlot: boolean;
  readonly viewState: ConversationRunViewState;
}

// Module-level on purpose: an inline `components={{ Footer: () => ... }}`
// creates a new component type on every MessageList render (every streaming
// delta) and React remounts the footer each time. A stable identity plus the
// `context` prop keeps the DOM while values still update.
// Exported for its contract test (slot-height stability is the anti-jitter
// guarantee; MessageList.test.tsx mocks Virtuoso so it can't observe this).
export function ListFooter(props: { context?: FooterContext }): ReactElement {
  const ctx = props.context;
  return (
    <div className="message-list__footer-stack">
      {/* The dots only render in the footer-primary states (thinking /
       * preparing); tool_running swaps them for the Tool loader. Mounting and
       * unmounting the indicator on every state flip changed the content
       * height at the bottom, flipped Virtuoso's at-bottom state, and flashed
       * the follow pill on every thinking↔tool transition — so while a run
       * is live the slot keeps its height and only the content toggles. */}
      <div
        className={`message-list__footer-slot${ctx?.reserveFooterSlot ? ' message-list__footer-slot--pinned' : ''}`}
      >
        {ctx?.showStreamingFooter === true && (
          <StreamingIndicator visibleState={ctx.viewState} />
        )}
      </div>
      {/* v1.15.9.j: bottom spacer so the last content
       * item isn't pressed against the bottom edge
       * of the viewport. */}
      <div style={{ height: '120px' }} />
    </div>
  );
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
  // │ Follow-state is observation, not render data: the controller  │
  // │ lives in a ref and is fed the scroller's own scrollTop.       │
  // │                                                                │
  // │ Disarming keys off the SCROLL POSITION, not the input device. │
  // │ The previous wheel-up/PageUp-only disarm left follow armed    │
  // │ for scrollbar drags, touch and Home — every streaming delta   │
  // │ then yanked the view back to the bottom, which the user       │
  // │ experienced as violent scroll jitter during workflow runs.    │
  // │ Any upward scrollTop movement now disarms, however it was     │
  // │ produced. Downward movement (chasing the tail, Virtuoso's     │
  // │ compensation when rows mount above, our own pin scrolls)      │
  // │ never disarms.                                                 │
  // │                                                                │
  // │ Re-arming stays explicit: sending a message (the new turn is  │
  // │ the user's) and clicking the follow-tail pill.                │
  // ╰────────────────────────────────────────────────────────────────╯
  const followRef = useRef(createFollowController());
  // Mirror at-bottom in state so the "follow tail" pill can render (purely
  // visual). Virtuoso's atBottomStateChange is the source of truth.
  const [atBottom, setAtBottom] = useState(true);

  // The pill must not flash during the pin's catch-up gap: when content
  // grows at the bottom, Virtuoso reports not-at-bottom for the frames
  // before our scrollToIndex re-pins, and `!atBottom` alone would blink the
  // pill on every delta. A pinned (following) view never shows the pill;
  // a disarmed view always may.
  const showScrollBtn =
    !atBottom && !followRef.current.isFollowing() && props.messages.length > 0;
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
  // Stable identity for Virtuoso's `context`: a fresh object per render
  // would push the footer to re-render on every streaming delta. The slot
  // stays reserved for the whole live run so the dots can mount/unmount
  // without reshaping the tail.
  const reserveFooterSlot = running || showStreamingFooter;
  const footerContext = useMemo<FooterContext>(
    () => ({ showStreamingFooter, reserveFooterSlot, viewState }),
    [showStreamingFooter, reserveFooterSlot, viewState],
  );

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
        // One reverse walk answers "is there assistant output after this
        // phase" for every phase at once. The previous per-phase
        // slice+scan made this projection O(n²) per streaming delta,
        // which showed up as stutter on long workflow turns.
        const assistantAfter = new Array<boolean>(turnMsgs.length + 1).fill(false);
        for (let i = turnMsgs.length - 1; i >= 0; i -= 1) {
          const m = turnMsgs[i];
          assistantAfter[i] = assistantAfter[i + 1]! || (m?.kind === 'text' && m.role === 'assistant');
        }
        for (let index = 0; index < turnMsgs.length; index += 1) {
          const message = turnMsgs[index];
          if (!message) continue;
          const phase = phaseAtIndex.get(index);
          if (phase) {
            const isCurrentPhase = phase === lastPhase && !assistantAfter[phase.lastIndex + 1];
            result.push({
              kind: '__code_process',
              // firstIndex disambiguates the SAME phaseId appearing as two
              // non-contiguous runs within one turn (narration in between
              // splits the grouping). Keys must be unique — Virtuoso uses
              // them as React keys via computeItemKey — and stable: messages
              // only ever append, so a group's first index never shifts.
              key: `code-process:${currentTurn.turnId}:${phase.phaseId}:${phase.firstIndex}`,
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
        // Work turns: tool/thinking fold per phase (below). The linear
        // kinds (work_rail / work_narration / the retired
        // work_activity_group) pass through to <Message>, whose
        // safety-net branches render history-revived rows (the board
        // aggregation path was removed with WorkTaskBoard).
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
              // See the Code branch: firstIndex keeps keys unique when the
              // same phaseId reappears as a second non-contiguous run.
              key: `code-process:${currentTurn.turnId}:${wphase.phaseId}:${wphase.firstIndex}`,
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
    // props.running drives the Work branch's `active` flag on process
    // blocks; without it here a turn ending without a message delta
    // would leave the block expanded.
  }, [props.messages, props.surface, props.running, turnMetaByTurnId]);

  // v1.15.9.j → v1.18 (2026-09-06): when the user sends a NEW message,
  // reset to follow mode. Sending is the explicit "follow along
  // again" signal — even if the user had been scrolled up reading
  // the previous turn, the new turn is theirs and they want to watch
  // it unfold. After that, ANY upward movement of the scroller's
  // scrollTop disarms follow (see the follow controller above — it is
  // position-based, not input-device-based), until they re-arm it by
  // sending OR by clicking the follow-tail pill (which scrolls to
  // bottom AND re-arms follow).

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
      if (!m || isCodeProcessItem(m)) continue;
      if (m.kind === 'text' && m.role === 'user') {
        if (m.id !== lastUserMsgIdRef.current) {
          lastUserMsgIdRef.current = m.id;
          followRef.current.rearm();
          shouldScroll = true;
        }
        break;
      }
    }
    // Streaming / synthetic item growth: stay anchored when armed.
    if (followRef.current.isFollowing()) shouldScroll = true;

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

  // The scroller's own scroll events are the ONE disarm signal — they fire
  // for every input method (wheel, scrollbar drag, touch, Home/End,
  // keyboard) and for none of our own pin scrolls (those only move
  // scrollTop down). Attached through Virtuoso's `scrollerRef` below.
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const handleScrollerScroll = useCallback((): void => {
    const el = scrollerElRef.current;
    if (!el) return;
    const disarmed = followRef.current.onScroll(el.scrollTop);
    if (disarmed) {
      // Mirror to the pill state immediately; Virtuoso's
      // atBottomStateChange will agree a moment later.
      setAtBottom((prev) => (prev ? false : prev));
    }
  }, []);
  const attachScroller = useCallback(
    (el: HTMLElement | Window | null): void => {
      const prev = scrollerElRef.current;
      const next = el instanceof HTMLElement ? el : null;
      if (prev === next) return;
      if (prev) {
        prev.removeEventListener('scroll', handleScrollerScroll);
      }
      scrollerElRef.current = next;
      // Window-scrolled lists are not a thing here (the scroller is always
      // an element); skip listening when Virtuoso hands us something else.
      if (next) {
        next.addEventListener('scroll', handleScrollerScroll, { passive: true });
      }
    },
    [handleScrollerScroll],
  );

  // 2026-09-06 (v1.18): auto-scroll lives in the items-change effect
  // above, gated by the follow controller. `followOutput` is disabled
  // (see its note) so there is exactly one scroll driver; atBottomState
  // Change only mirrors geometry to the pill state.

  return (
    <div className="message-list" data-message-list-root="" role="list" aria-label="Chat">
      <Virtuoso
        ref={virtuosoRef}
        style={{ height: '100%' }}
        scrollerRef={attachScroller}
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
          // 2026-09-10 (applyWorkItem deletion面): the `workflow` branch
          // (WorkWorkflowCard) is deleted with the WorkflowMessage chain —
          // its only producers (mapper/reducer) are gone. A stale persisted
          // `workflow` row falls through to <Message>, which renders nothing.
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
              onEditMessage={props.onEditMessage}
              onSaveEdit={props.onSaveEdit}
              onCancelEdit={props.onCancelEdit}
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
        // Apply item measurements synchronously instead of deferring them
        // through requestAnimationFrame: during a streaming run the tail row
        // grows every delta, and the deferred pass kept the corrections one
        // frame behind the layout — a flicker two react-virtuoso users
        // traced to the 4.7.6 rAF change (discussion #1083).
        skipAnimationFrameInResizeObserver
        // Stable item keys: Virtuoso's default is the array index, but a
        // projection item (a code/work process block) is replaced wholesale
        // when its entries grow. Keying by identity lets Virtuoso reuse the
        // mounted row instead of treating it as new content.
        computeItemKey={(_index, item) => (isCodeProcessItem(item) ? item.key : item.id)}
        // Render a gutter beyond the viewport so slow scrolling mounts rows
        // ahead of time instead of synchronously inside the scroll frame.
        // This is the main smoothing lever for scrolling up against a list
        // that is growing at the bottom.
        increaseViewportBy={{ top: 900, bottom: 900 }}
        context={footerContext}
        components={{
          Footer: ListFooter,
          Item: VirtuosoItem,
        }}
      />
      {showScrollBtn && (
        // 2026-09-06: the trailing pill re-arms follow mode + smoothly
        // scrolls to the bottom in one click. Re-arm signals are the pill
        // click and sending a new message; scrolling up by any means
        // disarms (see the follow controller above). The pill is
        // intentionally icon-only; the design note said a small icon is
        // enough.
        <button
          type="button"
          className="message-list__scroll-btn message-list__scroll-btn--show"
          onClick={() => {
            followRef.current.rearm();
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
