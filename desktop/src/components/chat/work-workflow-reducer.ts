// Trylo Desktop — Work workflow reducer (WP-1 of the
// TRYLO-WORKFLOW-APPROVAL-DIFF-UI-IMPROVEMENT-SPEC-2026-08-29
// refactor).
//
// Pure, idempotent reducer that maintains a single
// `WorkflowMessage` per Work run inside the `ChatMessage[]`
// produced by `work-item-mapper`. It does NOT create
// ToolMessage / ThinkingMessage / etc. — those are owned
// by the existing mapper. This reducer's only job is the
// workflow-level card.
//
// Invariants enforced (spec §2.3):
//   1. started + finished same phase → 1 phase (status: completed)
//   2. duplicate plan-started → 1 phase, no extra activity
//   3. duplicate plan-finished → 1 phase, no state flip
//   4. finished before started (out-of-order) → merged, no crash
//   5. completed phase does not regress to active on late started
//   6. failed phase does not regress to active on late started
//   7. unknown plan group → title '执行步骤', original name in diagnostics
//   8. cross-run isolation: another run's plan does not mutate this
//      run's workflow
//   9. replay (same items twice) → identical final workflow
//  10. terminal (final/error/cancelled) after which a late started
//      arrives → workflow not duplicated, phase not revived
//
// Item routing:
//   plan / thinking / tool / progress / final / error / cancelled
//     → may touch the workflow
//   progress with toolCallId, approval, input_request, artifact,
//   diagnostics
//     → pass-through (the mapper / upstream handle them)

import type { ConversationItem } from '@trylo/work';
import type {
  ChatMessage,
  WorkflowActivity,
  WorkflowMessage,
  WorkflowPhase,
} from './types';

/** Title length cap for phases. Longer names are truncated
 *  with an ellipsis so the card header stays one line. */
const PHASE_TITLE_CAP = 40;

/** Label length cap for activities. The card shows up to
 *  three of these; truncation keeps the card compact. */
const ACTIVITY_LABEL_CAP = 50;

/** Phase identifier derived from an item. Resolution order
 *  (spec §2.2):
 *    1. upstream `phaseId` (groupId) when present;
 *    2. existing phase in the workflow whose normalized
 *       title matches the item's name (so `Completed
 *       DISCOVER` finds the `DISCOVER` phase created by
 *       `Starting DISCOVER`);
 *    3. synthesized key: `runId + ':' + normalized(name) +
 *       ':' + ordinal` where ordinal is the count of
 *       existing phases sharing the same normalized name.
 *  Display text alone is never used as a key. */
function resolvePhaseKey(
  item: ConversationItem & { kind: 'plan' },
  workflow: WorkflowMessage | undefined,
): string {
  if (item.phaseId !== undefined && item.phaseId.length > 0) {
    return item.phaseId;
  }
  const normalizedName = item.name.length > 0
    ? normalizePhaseName(item.name)
    : 'default';
  if (workflow !== undefined) {
    const match = workflow.phases.find(
      (p) => normalizePhaseName(p.title) === normalizedName,
    );
    if (match) return match.id;
  }
  let ordinal = 0;
  if (workflow !== undefined) {
    for (const p of workflow.phases) {
      if (normalizePhaseName(p.title) === normalizedName) ordinal += 1;
    }
  }
  return `${item.runId}:${normalizedName}:${ordinal}`;
}

/** Strip the "Starting"/"Completed"/"完成"/"开始" prefix
 *  the upstream text sometimes carries, so the card title
 *  reads as the phase name only. */
export function normalizePhaseName(raw: string): string {
  const trimmed = raw.trim();
  // Common upstream prefixes, case-insensitive.
  const patterns = [
    /^starting\s+/i,
    /^completed\s+/i,
    /^完成\s*/i,
    /^开始\s*/i,
    /^adjusting\s+the\s+plan\s*[-—:]\s*/i,
  ];
  let out = trimmed;
  for (const p of patterns) {
    out = out.replace(p, '');
  }
  return out.length > 0 ? out : trimmed;
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap - 1)}…`;
}

/** Heuristic: does this `plan: finished` item represent a
 *  failure? The upstream API only has `started | finished`,
 *  so failure is inferred from the text / name. The
 *  `event-presenter` keeps the upstream message verbatim
 *  in `text`; the "Completed X" vs "X failed" distinction
 *  lives there. */
function isPlanFailure(item: ConversationItem): boolean {
  if (item.kind !== 'plan') return false;
  const haystack = `${item.name} ${item.text}`.toLowerCase();
  return (
    haystack.includes('failed') ||
    haystack.includes('failure') ||
    haystack.includes('错误') ||
    haystack.includes('失败')
  );
}

function buildWorkflowId(runId: string): string {
  return `workflow:${runId}`;
}

function isWorkflowMessage(m: ChatMessage): m is WorkflowMessage {
  return m.kind === 'workflow';
}

function findWorkflow(
  messages: readonly ChatMessage[],
  workflowId: string,
): { readonly workflow: WorkflowMessage; readonly index: number } | undefined {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && isWorkflowMessage(m) && m.workflowId === workflowId) {
      return { workflow: m, index: i };
    }
  }
  return undefined;
}

function upsertWorkflow(
  messages: readonly ChatMessage[],
  next: WorkflowMessage,
): readonly ChatMessage[] {
  const found = findWorkflow(messages, next.workflowId);
  if (!found) {
    return [...messages, next];
  }
  // Reference-equal short-circuit: the reducer returns the
  // input array unchanged when no mutation is needed, so
  // the caller can use `=== ` to detect "nothing changed".
  if (found.workflow === next) return messages;
  const out = messages.slice();
  out[found.index] = next;
  return out;
}

function appendActivity(
  phase: WorkflowPhase,
  activity: WorkflowActivity,
): WorkflowPhase {
  // Duplicate-id guard: re-receiving the same activity id
  // is a no-op (replay / repeated progress marker).
  if (phase.activities.some((a) => a.id === activity.id)) {
    return phase;
  }
  return { ...phase, activities: [...phase.activities, activity] };
}

function makePhase(
  id: string,
  title: string,
  at: number,
): WorkflowPhase {
  return {
    id,
    title,
    status: 'pending',
    startedAt: at,
    activities: [],
  };
}

function makeWorkflow(
  runId: string,
  turnId: string | undefined,
  firstPhase: WorkflowPhase,
  createdAt: number,
): WorkflowMessage {
  return {
    id: buildWorkflowId(runId),
    kind: 'workflow',
    role: 'assistant',
    createdAt,
    turnId,
    workflowId: buildWorkflowId(runId),
    runId,
    status: 'running',
    phases: [firstPhase],
  };
}

function replacePhase(
  workflow: WorkflowMessage,
  phaseId: string,
  next: WorkflowPhase,
): WorkflowMessage {
  const idx = workflow.phases.findIndex((p) => p.id === phaseId);
  if (idx === -1) {
    return { ...workflow, phases: [...workflow.phases, next] };
  }
  if (workflow.phases[idx] === next) return workflow;
  const phases = workflow.phases.slice();
  phases[idx] = next;
  return { ...workflow, phases };
}

function findActivePhase(workflow: WorkflowMessage): WorkflowPhase | undefined {
  for (let i = workflow.phases.length - 1; i >= 0; i--) {
    const p = workflow.phases[i];
    if (p && p.status === 'active') return p;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/** Apply one ConversationItem to the messages array, updating
 *  the run's WorkflowMessage when the item is workflow-relevant.
 *  Pass-through for items the workflow does not own. */
export function applyWorkflowItem(
  messages: readonly ChatMessage[],
  item: ConversationItem,
): readonly ChatMessage[] {
  const workflowId = buildWorkflowId(item.runId);
  switch (item.kind) {
    case 'plan':
      return applyPlan(messages, item, workflowId);
    case 'thinking':
      return applyActivity(messages, item, workflowId, 'thinking');
    case 'tool':
      return applyActivity(messages, item, workflowId, 'tool');
    case 'progress':
      // Progress with a toolCallId is command output that
      // the work-item-mapper routes to the matching
      // ToolMessage. The workflow does not own it; skip
      // to keep the activity list free of duplicates.
      if (item.toolCallId !== undefined) return messages;
      return applyActivity(messages, item, workflowId, 'notice');
    case 'final':
      return applyTerminal(messages, item, workflowId, 'completed');
    case 'error':
      return applyTerminal(messages, item, workflowId, 'failed');
    case 'cancelled':
      return applyTerminal(messages, item, workflowId, 'cancelled');
    case 'approval':
    case 'input_request':
    case 'artifact':
    case 'deliverable_fact':
    case 'diagnostics':
      return messages;
  }
}

// ---------------------------------------------------------------------------
// Plan handling.
// ---------------------------------------------------------------------------

function applyPlan(
  messages: readonly ChatMessage[],
  item: ConversationItem & { kind: 'plan' },
  workflowId: string,
): readonly ChatMessage[] {
  if (item.kind !== 'plan') return messages; // type guard
  const existing = findWorkflow(messages, workflowId);
  const phaseKey = resolvePhaseKey(item, existing?.workflow);
  const title = truncate(
    normalizePhaseName(item.name),
    PHASE_TITLE_CAP,
  );

  if (!existing) {
    // First plan event for the run — bootstrap a workflow
    // with one phase.
    const phase = makePhase(phaseKey, title, item.at);
    if (item.stage === 'finished') {
      // Out-of-order: finished before started (spec §2.3 #4).
      // The phase is born already terminal.
      const finished: WorkflowPhase = {
        ...phase,
        status: isPlanFailure(item) ? 'failed' : 'completed',
        finishedAt: item.at,
      };
      return upsertWorkflow(
        messages,
        makeWorkflow(item.runId, item.turnId, finished, item.at),
      );
    }
    const active: WorkflowPhase = { ...phase, status: 'active' };
    return upsertWorkflow(
      messages,
      makeWorkflow(item.runId, item.turnId, active, item.at),
    );
  }

  const { workflow } = existing;
  const phaseIdx = workflow.phases.findIndex((p) => p.id === phaseKey);
  if (phaseIdx === -1) {
    // New phase for an existing workflow.
    const phase = makePhase(phaseKey, title, item.at);
    if (item.stage === 'finished') {
      const finished: WorkflowPhase = {
        ...phase,
        status: isPlanFailure(item) ? 'failed' : 'completed',
        finishedAt: item.at,
      };
      const next = upsertWorkflow(messages, {
        ...workflow,
        phases: [...workflow.phases, finished],
      });
      return next;
    }
    const active: WorkflowPhase = { ...phase, status: 'active' };
    const next = upsertWorkflow(messages, {
      ...workflow,
      phases: [...workflow.phases, active],
    });
    return next;
  }

  const current = workflow.phases[phaseIdx];
  if (!current) return messages;

  // Spec §2.3 #2-#6: idempotent phase transitions, no
  // regressions from terminal back to active.
  if (item.stage === 'started') {
    if (current.status === 'pending') {
      const activated: WorkflowPhase = { ...current, status: 'active' };
      return upsertWorkflow(messages, replacePhase(workflow, phaseKey, activated));
    }
    // active / completed / failed / cancelled → no-op.
    return messages;
  }

  // stage === 'finished'
  if (current.status === 'completed' || current.status === 'failed'
      || current.status === 'cancelled') {
    // Spec §2.3 #3: duplicate plan-finished → no state flip.
    return messages;
  }
  if (current.status === 'pending') {
    // No prior `started` arrived — born terminal.
    const finished: WorkflowPhase = {
      ...current,
      status: isPlanFailure(item) ? 'failed' : 'completed',
      finishedAt: item.at,
    };
    return upsertWorkflow(messages, replacePhase(workflow, phaseKey, finished));
  }
  // active → completed / failed.
  const finished: WorkflowPhase = {
    ...current,
    status: isPlanFailure(item) ? 'failed' : 'completed',
    finishedAt: item.at,
  };
  return upsertWorkflow(messages, replacePhase(workflow, phaseKey, finished));
}

// ---------------------------------------------------------------------------
// Activity appends (thinking / tool / progress-no-toolCallId).
// ---------------------------------------------------------------------------

type ActivityKind = WorkflowActivity['kind'];

function applyActivity(
  messages: readonly ChatMessage[],
  item: ConversationItem,
  workflowId: string,
  kind: ActivityKind,
): readonly ChatMessage[] {
  const existing = findWorkflow(messages, workflowId);
  if (!existing) return messages;
  const { workflow } = existing;

  // If the workflow already terminated, a late activity
  // does not re-open it. Spec §2.3 #10.
  if (workflow.status !== 'running') return messages;

  const active = findActivePhase(workflow);
  if (!active) {
    // No active phase — no place to attach the activity.
    // Skip rather than resurrecting a finished phase.
    return messages;
  }

  const activity: WorkflowActivity = makeActivity(item, kind);
  const nextPhase = appendActivity(active, activity);
  if (nextPhase === active) return messages;
  return upsertWorkflow(messages, replacePhase(workflow, active.id, nextPhase));
}

function makeActivity(
  item: ConversationItem,
  kind: ActivityKind,
): WorkflowActivity {
  const status: WorkflowActivity['status'] =
    item.kind === 'tool'
      ? item.status === 'error'
        ? 'failed'
        : item.status === 'running'
          ? 'running'
          : 'completed'
      : 'completed';
  const labelSource =
    item.kind === 'thinking' || item.kind === 'progress'
      ? item.text
      : item.kind === 'tool'
        ? `${item.tool}: ${item.summary}`
        : '';
  return {
    id: item.id,
    kind,
    label: truncate(labelSource, ACTIVITY_LABEL_CAP),
    status,
    at: item.at,
    ...(item.kind === 'tool' ? { toolMessageId: item.id } : {}),
  };
}

// ---------------------------------------------------------------------------
// Terminal handling (final / error / cancelled).
// ---------------------------------------------------------------------------

function applyTerminal(
  messages: readonly ChatMessage[],
  item: ConversationItem,
  workflowId: string,
  terminal: 'completed' | 'failed' | 'cancelled',
): readonly ChatMessage[] {
  const existing = findWorkflow(messages, workflowId);
  if (!existing) return messages;
  const { workflow } = existing;

  // Close every still-active phase.
  let nextWorkflow = workflow;
  let changed = false;
  const nextPhases = workflow.phases.map((p) => {
    if (p.status === 'active' || p.status === 'pending') {
      changed = true;
      return {
        ...p,
        status: terminal === 'completed' ? 'completed' as const
          : terminal === 'failed' ? 'failed' as const
            : 'cancelled' as const,
        finishedAt: item.at,
      };
    }
    return p;
  });
  if (changed) {
    nextWorkflow = { ...nextWorkflow, phases: nextPhases };
  }
  if (nextWorkflow.status === 'running') {
    nextWorkflow = { ...nextWorkflow, status: terminal };
  }
  return upsertWorkflow(messages, nextWorkflow);
}
