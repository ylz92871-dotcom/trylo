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
import { TurnProgress } from './TurnProgress';
import {
  createFollowController,
  FOLLOW_TAIL_THRESHOLD,
  shouldForceTailPin,
  shouldShowFollowPill,
} from './follow-controller';
import { VirtuosoItem } from './virtuoso-item';
// 2026-09-10 (applyWorkItem deletion面): WorkWorkflowCard deleted with the
// WorkflowMessage chain (zero production producers). The linear rail /
// narration / deliverable panels below are different kinds and stay.
import { DeliverableProgressPanel } from './DeliverableProgressPanel';
import { coalesceToolReplays } from './coalesce-tool-replays';
import {
  CodeReasoningTranscript,
  type CodeProcessEntry,
} from './CodeReasoningTranscript';
import type { ChatMessage, TextMessage, SubagentMessage } from './types';
import { CollaborationGroup } from './CollaborationGroup';
import { AgentParticipation } from './AgentParticipation';
import {
  type ConversationRunViewState,
  deriveConversationRunViewState,
  viewStateShowsFooterDots,
} from './view-state';

export interface MessageListProps {
  readonly selectedSubagentId?: string | null;
  readonly onSelectSubagent?: (messageId: string) => void;
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
  readonly onRespondInputRequest?: import('./InputRequestCard').InputRequestCardProps['onRespond'];
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

type TurnTimingItem = {
  readonly kind: '__turn_timing';
  readonly id: string;
  readonly user: TextMessage;
};
type CollaborationItem = { readonly kind: '__collaboration'; readonly id: string;
  readonly turnId: string; readonly agents: readonly SubagentMessage[]; readonly active: boolean };
export type ListItem = ChatMessage | CodeProcessItem | TurnTimingItem | CollaborationItem;

function isCodeProcessItem(item: ListItem): item is CodeProcessItem {
  return item.kind === '__code_process';
}

/** Round-3 (P1-6): how far from the bottom still counts as "at the tail".
 *  Used only to decide whether the index-based pin actually landed; it is
 *  never used to disarm following (that is the follow controller's job). */
const TAIL_TOLERANCE = 4;

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
  // A single scroll driver follows measured layout while the reader stays at the tail.
  const followRef = useRef(createFollowController());
  // Mirror at-bottom in state so the "follow tail" pill can render (purely
  // visual). Virtuoso's atBottomStateChange is the source of truth.
  const [atBottom, setAtBottom] = useState(true);
  const [, refreshFollowState] = useState(0);

  // Show a return action while reading history, including after completion.
  const running = props.running === true;
  const showScrollBtn = shouldShowFollowPill({
    running,
    atBottom,
    following: followRef.current.isFollowing(),
    messageCount: props.messages.length,
  });

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
      const allTurnMsgs = coalesceToolReplays(currentTurn.msgs);
      const agents = allTurnMsgs.filter((message): message is SubagentMessage => message.kind === 'subagent');
      // Structured collaboration replaces successful orchestration receipts.
      // Failed calls stay visible; persisted messages remain lossless.
      const orchestration = new Set(['spawn_agent', 'send_input', 'wait_agent', 'close_agent', 'resume_agent', 'delegate_subagent', 'Agent', 'Task']);
      const turnMsgs = agents.length === 0 ? allTurnMsgs : allTurnMsgs.filter(message =>
        message.kind !== 'tool' || !orchestration.has(message.tool) || message.status === 'error' || message.status === 'interrupted');
      const appendMessage = (message: ChatMessage): void => {
        if (message.kind !== 'subagent') { result.push(message); return; }
        if (message === agents[0]) result.push({ kind: '__collaboration', id: `collaboration:${currentTurn!.turnId}`,
          turnId: currentTurn!.turnId, agents,
          active: turnMetaByTurnId.get(currentTurn!.turnId)?.isActive === true });
        result.push(message);
      };
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
            appendMessage(message);
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
            // Keep the active Work reasoning or tool phase open. A phase
            // with only thinking must stream before any tool is called. Once the phase's tools complete it collapses
            // (green ✓) rather than staying expanded+spinning until the entire
            // task finishes. Whole-task end (`running` false) also collapses it.
            const phaseHasActiveTool = wphase.entries.some(
              (e): boolean => e.kind === 'tool' && (e.status === 'running' || e.status === 'pending'),
            );
            const phaseTail = wphase.entries.at(-1);
            const phaseHasLiveReasoning = phaseTail === turnMsgs.at(-1)
              && phaseTail?.kind === 'thinking' && phaseTail.partial === true;
            result.push({
              kind: '__code_process',
              // See the Code branch: firstIndex keeps keys unique when the
              // same phaseId reappears as a second non-contiguous run.
              key: `code-process:${currentTurn.turnId}:${wphase.phaseId}:${wphase.firstIndex}`,
              turnId: currentTurn.turnId,
              phaseId: wphase.phaseId,
              entries: wphase.entries,
              active: props.running === true && (phaseHasActiveTool || phaseHasLiveReasoning),
            });
            continue;
          }
          if (message.kind === 'tool' || message.kind === 'thinking') continue;
          appendMessage(message);
        }
      }
      const user = turnMsgs.find((message): message is TextMessage =>
        message.kind === 'text' && message.role === 'user');
      if (user?.turnTiming && !turnMetaByTurnId.get(currentTurn.turnId)?.isActive) {
        result.push({ kind: '__turn_timing', id: `turn-timing:${currentTurn.turnId}`, user });
      }
      currentTurn = null;
    };

    for (const m of props.messages) {
      // Context measurements remain persisted for the ring, never as empty timeline rows.
      if (m.kind === 'notice' && !m.text.trim()) continue;
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

  // Sending a new turn resumes follow. Reader input can pause it again.

  // Refs that survive across renders without re-triggering them.
  const lastUserMsgIdRef = useRef<string | null>(null);
  // Round-3 (P1-6): the scroller element itself. Declared before the pin
  // effect so the absolute tail scroll can read real geometry.
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const userScrollUntilRef = useRef(0);
  const touchYRef = useRef<number | null>(null);

  /** Keep Virtuoso's measured range and the browser's actual tail aligned.
   *  Instant movement avoids accumulating smooth animations during a stream. */
  const pinToTail = useCallback(
    (): void => {
      if (items.length > 0) virtuosoRef.current?.scrollToIndex({ index: items.length - 1, align: 'end', behavior: 'auto' });
      const el = scrollerElRef.current;
      if (!el) return;
      if (userScrollUntilRef.current !== Number.POSITIVE_INFINITY) userScrollUntilRef.current = 0;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance > TAIL_TOLERANCE) el.scrollTop = el.scrollHeight;
      followRef.current.sync({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    },
    [items.length],
  );

  const pinFrameRef = useRef<number | null>(null);
  const scheduleTailPin = useCallback((): void => {
    if (pinFrameRef.current !== null) return;
    pinFrameRef.current = requestAnimationFrame(() => {
      pinFrameRef.current = null;
      if (followRef.current.isFollowing()) pinToTail();
    });
  }, [pinToTail]);
  useEffect(() => () => {
    if (pinFrameRef.current !== null) cancelAnimationFrame(pinFrameRef.current);
    pinFrameRef.current = null;
  }, [scheduleTailPin]);
  useEffect(() => {
    const el = scrollerElRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(scheduleTailPin);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scheduleTailPin]);

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
    pinToTail();
    scheduleTailPin();
  }, [items, pinToTail, scheduleTailPin]);

  // Finishing a run preserves a reader who deliberately left the tail.
  const wasRunningRef = useRef(running);
  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = running;
    if (!shouldForceTailPin(wasRunning, running, followRef.current.isFollowing())) return;
    followRef.current.rearm();
    setAtBottom(true);
    pinToTail();
  }, [running, pinToTail]);

  // Virtualizer corrections can move scrollTop without changing total height.
  // Only observations associated with reader input may change follow intent.
  const handleScrollerScroll = useCallback((): void => {
    const el = scrollerElRef.current;
    if (!el) return;
    // Round-3 (P1-6): the controller needs the whole geometry, not just
    // scrollTop — see follow-controller.ts. A row collapsing ABOVE the tail
    // moves scrollTop up by the height it lost, and the browser does that on
    // the user's behalf; only the un-explained remainder is the user.
    const wasFollowing = followRef.current.isFollowing();
    followRef.current.observe({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }, performance.now() <= userScrollUntilRef.current);
    if (!wasFollowing && followRef.current.isFollowing() && userScrollUntilRef.current !== Number.POSITIVE_INFINITY) userScrollUntilRef.current = 0;
    const bottom = el.scrollHeight - el.clientHeight - el.scrollTop <= FOLLOW_TAIL_THRESHOLD;
    setAtBottom(bottom);
    if (wasFollowing !== followRef.current.isFollowing()) refreshFollowState(value => value + 1);
  }, []);
  const pauseFollow = useCallback((): void => {
    if (!followRef.current.isFollowing()) return;
    followRef.current.pause();
    refreshFollowState(value => value + 1);
  }, []);
  const handleWheel = useCallback((event: WheelEvent): void => {
    // A scrollable tool output owns its wheel until it reaches its top.
    for (const node of event.composedPath()) {
      if (node === scrollerElRef.current) break;
      if (node instanceof HTMLElement && node.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
    }
    userScrollUntilRef.current = performance.now() + 1000;
    if (event.deltaY < 0 && scrollerElRef.current?.scrollTop) pauseFollow();
  }, [pauseFollow]);
  const handleKeyDown = useCallback((event: KeyboardEvent): void => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === 'End') {
      event.preventDefault();
      followRef.current.rearm();
      setAtBottom(true);
      pinToTail();
      scheduleTailPin();
      return;
    }
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab'].includes(event.key)) userScrollUntilRef.current = performance.now() + 1000;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) pauseFollow();
  }, [pauseFollow, pinToTail, scheduleTailPin]);
  const handlePointerDown = useCallback((event: PointerEvent): void => {
    const el = scrollerElRef.current;
    if (!el || event.target !== el) return;
    const rect = el.getBoundingClientRect();
    if (event.clientX < rect.right - Math.max(12, el.offsetWidth - el.clientWidth)) return;
    // Scrollbar presses target the scroller itself, not the message children.
    userScrollUntilRef.current = Number.POSITIVE_INFINITY;
    pauseFollow();
  }, [pauseFollow]);
  const handlePointerUp = useCallback((): void => {
    if (userScrollUntilRef.current === Number.POSITIVE_INFINITY) userScrollUntilRef.current = performance.now() + 1000;
  }, []);
  const handleTouchStart = useCallback((event: TouchEvent): void => {
    touchYRef.current = event.touches[0]?.clientY ?? null;
    userScrollUntilRef.current = performance.now() + 1500;
  }, []);
  const handleTouchMove = useCallback((event: TouchEvent): void => {
    const y = event.touches[0]?.clientY;
    if (y === undefined) return;
    userScrollUntilRef.current = performance.now() + 1500;
    if (touchYRef.current !== null && y > touchYRef.current + 1 && scrollerElRef.current?.scrollTop) pauseFollow();
    touchYRef.current = y;
  }, [pauseFollow]);
  const attachScroller = useCallback(
    (el: HTMLElement | Window | null): void => {
      const prev = scrollerElRef.current;
      const next = el instanceof HTMLElement ? el : null;
      if (prev === next) return;
      if (prev) {
        prev.removeEventListener('scroll', handleScrollerScroll);
        prev.removeEventListener('wheel', handleWheel);
        prev.removeEventListener('keydown', handleKeyDown);
        prev.removeEventListener('pointerdown', handlePointerDown);
        prev.removeEventListener('touchstart', handleTouchStart);
        prev.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('pointercancel', handlePointerUp);
        window.removeEventListener('blur', handlePointerUp);
      }
      scrollerElRef.current = next;
      // Window-scrolled lists are not a thing here (the scroller is always
      // an element); skip listening when Virtuoso hands us something else.
      if (next) {
        followRef.current.sync({ scrollTop: next.scrollTop, scrollHeight: next.scrollHeight, clientHeight: next.clientHeight });
        next.addEventListener('scroll', handleScrollerScroll, { passive: true });
        next.addEventListener('wheel', handleWheel, { passive: true });
        next.addEventListener('keydown', handleKeyDown);
        next.addEventListener('pointerdown', handlePointerDown);
        next.addEventListener('touchstart', handleTouchStart, { passive: true });
        next.addEventListener('touchmove', handleTouchMove, { passive: true });
        document.addEventListener('pointerup', handlePointerUp, { passive: true });
        document.addEventListener('pointercancel', handlePointerUp, { passive: true });
        window.addEventListener('blur', handlePointerUp);
      }
    },
    [handleScrollerScroll, handleWheel, handleKeyDown, handlePointerDown, handlePointerUp, handleTouchStart, handleTouchMove],
  );

  // All pins share the same intent gate, including asynchronous measurements.

  return (
    <div className="message-list" data-message-list-root="" role="list" aria-label="Chat">
      <Virtuoso
        ref={virtuosoRef}
        tabIndex={0}
        style={{ height: '100%' }}
        scrollerRef={attachScroller}
        data={items}
        itemContent={(_index, item) => {
          if (item.kind === '__collaboration') return <CollaborationGroup key={item.id} agents={item.agents}
            active={item.active} selectedId={props.selectedSubagentId} onSelect={props.onSelectSubagent} />;
          if (item.kind === 'subagent') return <AgentParticipation key={item.id} agent={item}
            selected={props.selectedSubagentId === item.id} onSelect={props.onSelectSubagent} />;
          if (item.kind === '__turn_timing') {
            return <TurnProgress key={item.id} turnStartedAt={item.user.turnStartedAt ?? null}
              timing={item.user.turnTiming} isActive={false} />;
          }
          if (isCodeProcessItem(item)) {
            const meta = turnMetaByTurnId.get(item.turnId);
            return (
              <CodeReasoningTranscript
                key={item.key}
                entries={item.entries}
                turnId={item.turnId}
                phaseId={item.phaseId}
                workspacePath={props.workspacePath}
                onOpenArtifact={props.onOpenArtifact}
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
              onRespondInputRequest={props.onRespondInputRequest}
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
        totalListHeightChanged={scheduleTailPin}
        atBottomStateChange={(bottom) => {
          // Geometry alone cannot establish reader intent.
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
        // Explicit return works during streaming and after completion.
        <button
          type="button"
          className="message-list__scroll-btn message-list__scroll-btn--show"
          onClick={() => {
            followRef.current.rearm();
            setAtBottom(true);
            pinToTail();
            scheduleTailPin();
          }}
          aria-label="回到最新消息"
          title={running ? '回到最新消息并继续跟随' : '回到最新消息'}
        >
          <ArrowDown size={14} strokeWidth={2.4} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
