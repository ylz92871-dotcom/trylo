// Trylo Desktop — Work ConversationItem → ChatMessage mapper.
//
// v1.16.5+ (M3, Phase C): the Work presenter produces a
// stable `ConversationItem` union (semantic decisions);
// this pure module is the renderer-side half of that
// split — it turns items into the ChatMessage shapes the
// shared surface already knows (ThinkingCard / ToolCard /
// ArtifactCard / ErrorCard / text). It never reads raw
// daemon payloads and never decides semantics itself.
//
// Aggregation rules (the "don't spam the chat" contract):
//   - thinking + plan + progress fold into ONE ThinkingMessage
//     per PHASE (spec §6.3), not one per run. A phase opens
//     on a `timeline_group_started` (plan started with a new
//     groupId) or, without a groupId, when agent reasoning
//     resumes after a tool. A new phase completes the previous
//     card (partial=false → it stops streaming). The card
//     title comes from the plan stage; reasoning grows the
//     preview; progress markers only update its `activity`.
//   - tool items upsert by id (the presenter keys them on
//     the upstream stepId, so running → done/error edits
//     one card in place).
//   - artifacts dedupe per path per turn (re-emit marks
//     the card "updated" instead of appending a second).
//   - final / error / cancelled terminate the run (spec
//     §6.6): every still-partial phase card flips
//     partial=false (visual de-emphasis), still-running
//     tools flip to interrupted, and the turn timer is
//     frozen (finalElapsedMs) on the user message — the
//     ONLY freeze point. The timer keeps counting through
//     the run so the "已工作" value shows the full run
//     duration (§6.6.4). Freezing at the FIRST meaningful
//     output (spec §6.2's Code rule) is NOT applied here:
//     Work's plan stage markers arrive within the first
//     second, freezing the counter at ~0:00 — the
//     user-visible "Work 不会计时" defect (2026-08-28).

import type { ConversationItem } from '@trylo/work';
import {
  applyDeliverableItem,
  deliverableIdForRun,
  deliverableMessageId,
  detectArtifactKind,
  type ArtifactKind,
} from '@trylo/work';
import type {
  ArtifactMessage,
  ChatMessage,
  TextMessage,
  ThinkingMessage,
} from './types';
// 2026-08-29 (Work workflow UI refactor, spec §4.2): the
// plan branch no longer folds into a ThinkingMessage. It
// updates the run's WorkflowMessage instead. The new
// reducer is the only owner of workflow state.
import { applyWorkflowItem } from './work-workflow-reducer';

const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'document', 'presentation', 'spreadsheet', 'web', 'file',
];

/** Resolve the card kind for an artifact: accept only known
 *  upstream hints, otherwise derive from the file extension;
 *  unknown extensions render as a generic `file` card (P2-1,
 *  spec §8.6) — never a pretend document. Display decision
 *  only — both the inline card and the Dock go through this
 *  single helper. */
export function resolveArtifactKind(
  hint: string | undefined,
  filePath: string,
): ArtifactKind {
  if (hint !== undefined && (ARTIFACT_KINDS as readonly string[]).includes(hint)) {
    return hint as ArtifactKind;
  }
  return detectArtifactKind(filePath);
}

/** Max characters kept in the aggregated thinking preview.
 *  Older text is dropped from the head — the tail is what
 *  the user is reading. */
const PREVIEW_CAP = 4000;
/** Card title length cap. */
const SUMMARY_CAP = 80;

function truncateHead(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return text.slice(text.length - cap);
}

function shortSummary(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? text;
  const clean = firstLine.trim();
  return clean.length > SUMMARY_CAP
    ? `${clean.slice(0, SUMMARY_CAP - 1)}…`
    : clean;
}

/** The run (turn) an item belongs to, derived SOLELY from
 *  the item's own identity (spec §2.4, M3-P1-02): the
 *  persisted turnId when the binding carries one, else a
 *  stable synthetic key from the runId. The mapper never
 *  guesses "the latest user message" — that guess broke
 *  attribution whenever a second message existed or the
 *  run was recovered without its user bubble. */
function turnKeyOf(item: ConversationItem): string {
  return item.turnId ?? `work-run-${item.runId || item.conversationId}`;
}

/** Card id for one (turn, phase) pair (spec §6.3). */
function thinkingIdFor(turnKey: string, phaseKey: string): string {
  return `thinking-${turnKey}-${phaseKey}`;
}

/** Find the run's thinking card. */
function findThinking(
  messages: readonly ChatMessage[],
  id: string,
): ThinkingMessage | undefined {
  for (const m of messages) {
    if (m.kind === 'thinking' && m.id === id) return m;
  }
  return undefined;
}

function replaceById(
  messages: readonly ChatMessage[],
  id: string,
  next: ChatMessage,
): ChatMessage[] {
  return messages.map((m) => (m.id === id ? next : m));
}

/** Turn id stamped on Work-derived messages. Synthetic
 *  `work-run-*` keys (recovered runs without a persisted
 *  turnId) leave it undefined so they never alias another
 *  conversation's persisted turn. */
function turnIdOf(turnKey: string): string | undefined {
  return turnKey.startsWith('work-run-') ? undefined : turnKey;
}

/** Recover the phaseKey a card was created under from its
 *  id (`thinking-<turn>-<phaseKey>`). */
function phaseKeyOfCard(card: ThinkingMessage, turnKey: string): string {
  const prefix = `thinking-${turnKey}-`;
  return card.id.startsWith(prefix) ? card.id.slice(prefix.length) : card.id;
}

function indexOfMessage(
  messages: readonly ChatMessage[],
  id: string,
): number {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.id === id) return i;
  }
  return -1;
}

/** The turn's last thinking card, by array order. */
function lastThinkingOfTurn(
  messages: readonly ChatMessage[],
  turnKey: string,
): ThinkingMessage | undefined {
  const turnId = turnIdOf(turnKey);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.kind === 'thinking' && m.turnId === turnId) return m;
  }
  return undefined;
}

/** The turn's last still-partial thinking card — the phase
 *  card still streaming. Progress markers land on it. */
function lastPartialThinking(
  messages: readonly ChatMessage[],
  turnKey: string,
): ThinkingMessage | undefined {
  const turnId = turnIdOf(turnKey);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.kind === 'thinking' && m.turnId === turnId && m.partial) return m;
  }
  return undefined;
}

/** Did a tool of this turn run after `afterId`? Spec §6.3:
 *  without a groupId, reasoning that resumes after a tool
 *  opens a NEW phase (Code's "thinking after tool = new
 *  phase" rule). */
function toolRanAfter(
  messages: readonly ChatMessage[],
  afterId: string,
  turnKey: string,
): boolean {
  const turnId = turnIdOf(turnKey);
  for (let i = indexOfMessage(messages, afterId) + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.kind === 'tool' && m.turnId === turnId) return true;
  }
  return false;
}

function countThinkingOfTurn(
  messages: readonly ChatMessage[],
  turnKey: string,
): number {
  const turnId = turnIdOf(turnKey);
  let n = 0;
  for (const m of messages) {
    if (m.kind === 'thinking' && m.turnId === turnId) n += 1;
  }
  return n;
}

/** Which phase does a thinking/plan item land in (spec
 *  §6.3)?
 *    - authoritative groupId → key on it; a groupId that
 *      differs from the current card opens a new phase.
 *    - no groupId → stable default phases: consecutive
 *      agent updates share a card, reasoning resumed after
 *      a tool opens the next default phase.
 *    - a group-keyed card is current and this frame just
 *      lacks the groupId → stay in that named phase. */
interface PhaseResolution {
  readonly phaseKey: string;
  readonly newPhase: boolean;
}

function resolvePhase(
  messages: readonly ChatMessage[],
  turnKey: string,
  phaseId: string | undefined,
): PhaseResolution {
  const current = lastThinkingOfTurn(messages, turnKey);
  if (phaseId !== undefined) {
    return current && current.phaseId === phaseId
      ? { phaseKey: phaseId, newPhase: false }
      : { phaseKey: phaseId, newPhase: true };
  }
  if (!current) return { phaseKey: 'default-1', newPhase: true };
  const phaseKey = phaseKeyOfCard(current, turnKey);
  if (current.phaseId !== undefined) {
    return { phaseKey, newPhase: false };
  }
  if (toolRanAfter(messages, current.id, turnKey)) {
    return {
      phaseKey: `default-${countThinkingOfTurn(messages, turnKey) + 1}`,
      newPhase: true,
    };
  }
  return { phaseKey, newPhase: false };
}

/** Freeze every still-partial thinking card (run ended). */
function freezeThinking(
  messages: readonly ChatMessage[],
): readonly ChatMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    if (m.kind === 'thinking' && m.partial) {
      changed = true;
      return { ...m, partial: false } satisfies ChatMessage;
    }
    return m;
  });
  return changed ? out : messages;
}

/** Freeze the turn timer (spec §6.6.4): stamp
 *  `finalElapsedMs` on the user message that started the
 *  turn so TurnProgress shows a static "已工作 X:XX"
 *  instead of a live counter. frozen ONLY at the
 *  terminal item of the run (final / error / cancelled)
 *  so the displayed value is the FULL run duration.
 *  Freezing at the first meaningful output (Code's §6.2
 *  rule) is deliberately NOT applied: Work's plan stage
 *  markers arrive within the first second, freezing the
 *  counter at ~0:00 — the user-visible "Work 不会计时"
 *  defect (2026-08-28). Idempotent — a frozen value is
 *  never overwritten. Runs recovered without a persisted
 *  turnId (`work-run-*`) have no user bubble to freeze. */
function freezeTurnTimer(
  messages: readonly ChatMessage[],
  turnKey: string,
  at: number,
): readonly ChatMessage[] {
  const turnId = turnIdOf(turnKey);
  if (turnId === undefined) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.kind === 'text' && m.role === 'user' && m.id === turnId) {
      if (m.finalElapsedMs !== undefined) return messages;
      const started = m.turnStartedAt;
      if (started === undefined) return messages;
      const updated: TextMessage = {
        ...m,
        finalElapsedMs: Math.max(0, at - started),
      };
      return replaceById(messages, m.id, updated);
    }
  }
  return messages;
}

/** Terminal bookkeeping for one run (spec §6.2): every
 *  tool of THIS run still `running` flips to `interrupted`
 *  — the run ended underneath it. Never touches other
 *  runs' cards, and never claims the invocation failed. */
function closeRunTools(
  messages: readonly ChatMessage[],
  turnKey: string,
): readonly ChatMessage[] {
  const turnId = turnKey.startsWith('work-run-') ? undefined : turnKey;
  let changed = false;
  const out = messages.map((m) => {
    if (m.kind === 'tool' && m.status === 'running' && m.turnId === turnId) {
      changed = true;
      return { ...m, status: 'interrupted' } satisfies ChatMessage;
    }
    return m;
  });
  return changed ? out : messages;
}

/** Upsert the thinking card for the phase a patch belongs
 *  to. A new phase completes the previous partial card and
 *  opens a fresh one (spec §6.3). */
function upsertThinking(
  messages: readonly ChatMessage[],
  turnKey: string,
  patch: {
    readonly summary?: string;
    readonly appendText?: string;
    readonly activity?: string;
    /** Spec §5.2: the upstream groupId when the daemon
     *  names the phase; undefined → a synthesized default
     *  phase (b1-phase splits by it). */
    readonly phaseId?: string;
  },
  at: number,
): ChatMessage[] {
  const res = resolvePhase(messages, turnKey, patch.phaseId);
  const id = thinkingIdFor(turnKey, res.phaseKey);
  const existing = findThinking(messages, id);
  if (!existing) {
    // Complete the previous phase card of this turn before
    // opening the new one (§6.3) — it stops streaming.
    let next = messages;
    const prev = lastThinkingOfTurn(next, turnKey);
    if (prev && prev.id !== id && prev.partial) {
      next = replaceById(next, prev.id, { ...prev, partial: false });
    }
    const text = patch.appendText ?? '';
    const card: ThinkingMessage = {
      id,
      kind: 'thinking',
      role: 'assistant',
      createdAt: at,
      turnId: turnIdOf(turnKey),
      phaseId: res.phaseKey.startsWith('default-') ? undefined : res.phaseKey,
      summary: patch.summary ?? shortSummary(text),
      preview: truncateHead(text, PREVIEW_CAP),
      fullLength: text.length,
      partial: true,
      turn: 0,
      activity: patch.activity,
    };
    return [...next, card];
  }
  const mergedText = patch.appendText !== undefined
    ? `${existing.preview}\n${patch.appendText}`
    : existing.preview;
  const next: ThinkingMessage = {
    ...existing,
    summary: patch.summary ?? existing.summary,
    preview: truncateHead(mergedText, PREVIEW_CAP),
    fullLength:
      patch.appendText !== undefined
        ? existing.fullLength + patch.appendText.length + 1
        : existing.fullLength,
    activity: patch.activity ?? existing.activity,
    partial: true,
  };
  return replaceById(messages, id, next);
}

/** Apply one presenter item to the conversation. Pure:
 *  returns the input array unchanged when the item does
 *  not affect the visible chat (e.g. diagnostics). */
export function applyWorkItem(
  messages: readonly ChatMessage[],
  item: ConversationItem,
): readonly ChatMessage[] {
  const turnKey = turnKeyOf(item);
  // 2026-08-29 (redesign spec §3.1 / §4.1): the snapshotted
  // intent decides the rendering path — NEVER a tool-event
  // heuristic.
  //   - task         → shared Code card path (thinking/tool/plan/
  //                    progress become ordinary cards), plus the
  //                    deliverable projection panel (Work-specific);
  //   - conversation → answer content only: no scaffolding cards
  //                    (§3.1);
  //   - absent       → legacy frames (recovered runs without a
  //                    persisted intent) render terminal content
  //                    only, never leaking executor scaffolding.
  if (item.intent === 'task') {
    return applyTaskItem(messages, turnKey, item);
  }
  if (item.intent === 'conversation') {
    // Conversation runs still travel through the daemon's durable task
    // transport, so the upstream stream contains plan/thinking/progress
    // scaffolding even though the user only asked for an answer. Do not
    // leak that executor protocol into the chat. Only terminal content is
    // user-facing; all other events remain available in Diagnostics.
    switch (item.kind) {
      case 'final':
      case 'error':
      case 'cancelled':
        return applyItem(messages, turnKey, item);
      default:
        return messages;
    }
  }
  // Legacy branch (intent === undefined): old `.trylo/conversations.v1.json`
  // records only persisted taskId / turnId with NO intent field. Previously
  // these fell through to the old WorkflowMessage path, which leaked the
  // daemon's thinking / plan scaffolding into the chat as extra bubbles.
  // Render by conversation semantics (only terminal content) so recovery
  // never floods the chat with scaffolding.
  if (item.intent === undefined) {
    switch (item.kind) {
      case 'final':
      case 'error':
      case 'cancelled':
        return applyItem(messages, turnKey, item);
      default:
        return messages;
    }
  }
  const inner = applyItem(messages, turnKey, item);
  // 2026-08-29 (Work workflow UI refactor, spec §4.2): the
  // plan branch is the WorkflowCard's primary home (no
  // ThinkingMessage is produced). Every other case keeps
  // its existing behavior AND syncs the run's
  // WorkflowMessage via `applyWorkflowItem` at the end —
  // the reducer is idempotent and pass-through for kinds
  // it does not own (approval, input_request, artifact,
  // diagnostics).
  return applyWorkflowItem(inner, item);
}

// ---------------------------------------------------------------------------
// 2026-09-01 (New direction): Work task rendering shares Code's
// mature card UI (thinking/tool/plan/progress go to ordinary
// cards) — ONLY the deliverable projection (product panel) is
// kept as Work-specific. This reduces duplicate/heavy UI and
// keeps the common path aligned with Code.
// ---------------------------------------------------------------------------

function applyTaskItem(
  messages: readonly ChatMessage[],
  turnKey: string,
  item: ConversationItem,
): readonly ChatMessage[] {
  const turnId = turnIdOf(turnKey);
  let next = messages;

  // 1) Deliverable panel: keep as Work-specific — fold generator
  //    facts AND document/deck artifacts into the run's panel.
  //    Everything else falls through to the shared card path.
  if (item.kind === 'deliverable_fact' || item.kind === 'artifact') {
    const deliverableId = deliverableIdForRun(item.runId);
    const delMsgId = deliverableMessageId(deliverableId);
    const existingDel = next.find(
      (m): m is ChatMessage & { kind: 'deliverable' } =>
        m.kind === 'deliverable' && m.id === delMsgId,
    );
    const nextDel = applyDeliverableItem(existingDel?.projection, item);
    if (nextDel && nextDel !== existingDel?.projection) {
      next = existingDel
        ? replaceById(next, delMsgId, { ...existingDel, projection: nextDel })
        : [
            ...next,
            {
              id: delMsgId,
              kind: 'deliverable',
              role: 'assistant',
              createdAt: item.at,
              turnId,
              deliverableId,
              projection: nextDel,
            },
          ];
    }
    // deliverable_fact produces no chat card; artifact still renders its card.
    if (item.kind === 'deliverable_fact') return next;
  }

  // 2) All other item kinds (thinking/tool/plan/progress/artifact/
  //    approval/input_request/final/error/cancelled) go through the
  //    shared card path (same as Code).
  return applyItem(next, turnKey, item);
}

function applyItem(
  messages: readonly ChatMessage[],
  turnKey: string,
  item: ConversationItem,
): readonly ChatMessage[] {
  switch (item.kind) {
    case 'thinking': {
      // Aggregated reasoning is a phase card, not the freeze point:
      // the counter keeps counting so the terminal freeze shows the
      // full duration (see freezeTurnTimer). 2026-08-28: freezing at
      // the first plan/thinking marker froze the counter at ~0:00 and
      // made Work look like it "doesn't count time".
      return upsertThinking(
        messages,
        turnKey,
        { appendText: item.text, phaseId: item.phaseId },
        item.at,
      );
    }
    case 'plan': {
      // 2026-08-29 (Work workflow UI refactor, spec §4.2):
      // plan events are no longer projected to a
      // ThinkingMessage. The outer `applyWorkItem` routes
      // the plan to `applyWorkflowItem` which updates (or
      // creates) the run's WorkflowMessage — the
      // WorkflowCard renders the phase hierarchy. Started
      // and finished are state updates of the SAME phase,
      // not two ThinkingMessages. This branch is a
      // pass-through so the workflow reducer is the only
      // owner of plan-derived state.
      return messages;
    }
    case 'progress': {
      // Spec §6.4: when the frame carries a stable
      // toolCallId (the upstream stepId), this is command
      // output — append it to the matching ToolCard's
      // `output`, never to the thinking title or the chat
      // body. Replay guard: an exact tail match means the
      // segment was already appended.
      const turnId = turnIdOf(turnKey);
      if (item.toolCallId !== undefined) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (
            m &&
            m.kind === 'tool' &&
            m.toolCallId === item.toolCallId &&
            m.turnId === turnId
          ) {
            const existing = m.outputText ?? '';
            if (existing.endsWith(item.text)) return messages;
            const outputText =
              existing.length > 0 ? `${existing}\n${item.text}` : item.text;
            return replaceById(messages, m.id, { ...m, outputText });
          }
        }
        // No matching tool card yet — fall through to the
        // thinking activity line (spec §6.4: degrade only
        // when attribution is missing).
      }
      // Run feedback, not a chat row: it updates the
      // active (still-partial) phase card's status line.
      // With no active card there is nothing meaningful
      // to aggregate into — the raw line stays in
      // Diagnostics.
      const existing = lastPartialThinking(messages, turnKey);
      if (!existing) return messages;
      if (existing.activity === item.text) return messages;
      return replaceById(messages, existing.id, {
        ...existing,
        activity: item.text,
      });
    }
    case 'tool': {
      const existing = messages.find(
        (m): m is ChatMessage & { kind: 'tool' } =>
          m.kind === 'tool' && m.id === item.id,
      );
      if (!existing) {
        // No freeze here — the counter keeps counting until
        // the terminal item (see freezeTurnTimer).
        return [
          ...messages,
          {
            id: item.id,
            kind: 'tool',
            role: 'assistant',
            createdAt: item.at,
            turnId: turnKey.startsWith('work-run-') ? undefined : turnKey,
            // Spec §5.2/§6.4: carry the upstream identifiers
            // so phase grouping (ToolSummary) and command
            // output routing work identically to Code.
            phaseId: item.phaseId,
            toolCallId: item.toolCallId,
            tool: item.tool,
            status: item.status,
            summary: item.summary,
          },
        ];
      }
      return replaceById(messages, item.id, {
        ...existing,
        status: item.status,
        summary: item.summary.length > 0 ? item.summary : existing.summary,
        durationMs:
          item.status === 'running'
            ? existing.durationMs
            : item.at - existing.createdAt,
      });
    }
    case 'artifact': {
      // One card per path per run: a re-emit updates the
      // existing card instead of stacking duplicates.
      let duplicate: ArtifactMessage | undefined;
      for (const m of messages) {
        if (
          m.kind === 'artifact' &&
          m.filePath === item.filePath &&
          m.turnId === (turnKey.startsWith('work-run-') ? undefined : turnKey)
        ) {
          duplicate = m;
        }
      }
      if (duplicate) {
        return replaceById(messages, duplicate.id, {
          ...duplicate,
          updatedAt: item.at,
          updated: true,
        });
      }
      return [
        ...messages,
        {
          id: item.id,
          kind: 'artifact',
          role: 'assistant',
          createdAt: item.at,
          turnId: turnKey.startsWith('work-run-') ? undefined : turnKey,
          filePath: item.filePath,
          artifactKind: item.artifactKind,
          updatedAt: item.at,
        },
      ];
    }
    case 'final': {
      // Spec §6.6: terminal is atomic — freeze the turn
      // timer (safety net if no output arrived before),
      // freeze phase cards, interrupt still-running tools,
      // then append the single final message.
      const frozen = freezeTurnTimer(
        freezeThinking(messages),
        turnKey,
        item.at,
      );
      const next: ChatMessage[] = [
        ...closeRunTools(frozen, turnKey),
        {
          id: item.id,
          kind: 'text',
          role: 'assistant',
          createdAt: item.at,
          turnId: turnKey.startsWith('work-run-') ? undefined : turnKey,
          text: item.text,
        },
      ];
      return next;
    }
    case 'error': {
      return [
        ...closeRunTools(
          freezeTurnTimer(freezeThinking(messages), turnKey, item.at),
          turnKey,
        ),
        {
          id: item.id,
          kind: 'error',
          role: 'system',
          createdAt: item.at,
          turnId: turnKey.startsWith('work-run-') ? undefined : turnKey,
          userMessage: item.userMessage,
          diagnosticId: item.diagnosticId,
        },
      ];
    }
    case 'approval': {
      // M4-E: upsert by stable id (`approval:<runId>:<approvalId>`)
      // so approval_granted / approval_denied follow-ups update
      // the SAME card instead of stacking a second one. The
      // follow-up carries only the id + status; the original
      // card's copy is preserved.
      //
      // P3: the Work path is the authority for this card; the
      // Card uses the `preview` (built lazily from raw details
      // below) to show the safe summary + Diff entry.
      const existing = messages.find(
        (m): m is ChatMessage & { kind: 'approval' } =>
          m.kind === 'approval' && m.id === item.id,
      );
      if (!existing) {
        // The Work presenter forwards the upstream approval record
        // verbatim via `details`. We re-shape it into a preview
        // payload the ApprovalCard can consume without re-parsing
        // the raw tool input.
        const incoming = item as ConversationItem & {
          details?: Record<string, unknown>;
        };
        return [
          ...messages,
          {
            id: item.id,
            kind: 'approval',
            role: 'system',
            createdAt: item.at,
            turnId: turnKey.startsWith('work-run-') ? undefined : turnKey,
            approvalId: item.approvalId,
            type: item.type,
            description: item.description,
            status: item.status,
            autoApproved: item.autoApproved,
            authority: 'work' as const,
            ...(incoming.details
              ? { details: incoming.details }
              : {}),
          },
        ];
      }
      return replaceById(messages, item.id, {
        ...existing,
        status: item.status,
        autoApproved: item.autoApproved ?? existing.autoApproved,
        type: item.type ?? existing.type,
        description:
          item.description.length > 0 ? item.description : existing.description,
      });
    }
    case 'input_request': {
      // M4-E: same upsert-by-stable-id rule. input_request_
      // resolved / dismissed carry only the id + status (+
      // answers); the pending card's questions are preserved.
      const existing = messages.find(
        (m): m is ChatMessage & { kind: 'input_request' } =>
          m.kind === 'input_request' && m.id === item.id,
      );
      if (!existing) {
        return [
          ...messages,
          {
            id: item.id,
            kind: 'input_request',
            role: 'system',
            createdAt: item.at,
            turnId: turnKey.startsWith('work-run-') ? undefined : turnKey,
            requestId: item.requestId,
            questions: item.questions,
            status: item.status,
            answers: item.answers,
          },
        ];
      }
      return replaceById(messages, item.id, {
        ...existing,
        status: item.status,
        questions:
          item.questions.length > 0 ? item.questions : existing.questions,
        answers: item.answers ?? existing.answers,
      });
    }
    case 'cancelled': {
      // An explicit cancellation state (spec §6.2) — never
      // disguised as success (final text) or failure
      // (error card).
      const turnId = turnKey.startsWith('work-run-') ? undefined : turnKey;
      const closed = closeRunTools(
        freezeTurnTimer(freezeThinking(messages), turnKey, item.at),
        turnKey,
      );
      // Spec §11.2 "恰好一次": a cancelled run is terminal —
      // a replayed / re-emitted item must not stack a second
      // system row. If this turn already carries the same
      // cancelled row, return the closed state only.
      const alreadyCancelled = closed.some(
        (m) =>
          m.kind === 'text' &&
          m.role === 'system' &&
          m.text === item.text &&
          m.turnId === turnId,
      );
      if (alreadyCancelled) return closed;
      return [
        ...closed,
        {
          id: item.id,
          kind: 'text',
          role: 'system',
          createdAt: item.at,
          turnId,
          text: item.text,
        },
      ];
    }
    case 'deliverable_fact':
      // 2026-08-29 (redesign spec §8.7): generator tool facts
      // are owned by the DeliverableWorkflowAdapter (deliverable
      // projection message); the chat timeline never renders raw
      // tool inputs.
      return messages;
    case 'diagnostics':
      // Raw bookkeeping never enters the chat; the
      // Diagnostics drawer already carries it.
      return messages;
  }
}

// (P2-1 §10.3) the legacy `collectWorkArtifacts` message-scanning fallback was
// removed when ChatPanel switched to the scoped ResultDock. Keep the module
// tail reserved for future mappers.
