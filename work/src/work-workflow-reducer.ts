// Trylo Work — WorkWorkflowReducer.
//
// 2026-08-29 (Work end-to-end workflow redesign spec §11.3,
// §4.2, §6.1): the pure projection reducer. It consumes the
// existing semantic `ConversationItem` stream (produced by
// EventPresenter — the layer that already echoes vendor
// emitters) and folds it into a stable `WorkTurnProjection`:
//
//   phases       → for the PhaseRail (navigation only)
//   activities   → the linear, foldable activity stream
//   narrations   → white user-readable prose (per phase)
//   blockers     → approval / input nodes that pause the run
//   terminal     → the single final_answer / error / cancelled
//
// Layering rule (spec §11.3): React never parses raw
// `task.event` frames and this reducer never touches raw
// payloads — it only sees the already-semanticized items.
// Everything is pure and immutable; `reduceWorkItem` returns
// a NEW projection, never mutating its input.
//
// Two invariant guarantees mirror the spec:
//   - a `conversation` turn renders NO phases / activities /
//     blockers — it answers and reaches a terminal directly;
//   - once a terminal presentation is set, the projection is
//     FROZEN: any late item returns it unchanged (spec §3.3
//     "terminal 后晚到事件不得重新打开 spinner、工具或阶段").

import {
  isTerminal as isTaskTerminal,
  type TaskStatus,
} from "./task-registry.js";
import type { ConversationItem } from "./event-presenter.js";
import {
  WORK_SEMANTIC_PHASES,
  WORK_PHASE_LABELS,
  isTerminalTurnState,
  type WorkActivity,
  type WorkActivityKind,
  type WorkBlocker,
  type WorkNarrationMessage,
  type WorkPhaseState,
  type WorkRunIdentity,
  type WorkSemanticPhase,
  type WorkTerminalPresentation,
  type WorkTurnProjection,
  type WorkTurnState,
} from "./work-domain.js";

/** Batching window for like activities (spec §4.4): completed
 *  activities of the same kind+phase inside this window merge. */
const BATCH_WINDOW_MS = 5000;

/** Narration lines retained per phase. A long run emits hundreds of
 *  `thinking` items; keeping all of them would flood the panel, but keeping
 *  only the last one (the previous behaviour) discarded the reasoning —
 *  measured on the recorded runs: 318 thinking items → 11 narrations. */
const MAX_NARRATIONS_PER_PHASE = 8;

export interface ReduceOptions {
  readonly now?: () => number;
}

/** Build an empty projection for a run. State starts at the
 *  intent's running state (conversation → answering, task →
 *  understanding). */
export function createWorkTurnProjection(
  identity: WorkRunIdentity,
  _opts?: ReduceOptions,
): WorkTurnProjection {
  return {
    identity,
    state: identity.intent === "conversation" ? "answering" : "understanding",
    phases: [],
    narrations: [],
    activities: [],
    blockers: [],
    terminal: undefined,
  };
}

/** Fold ONE semantic item into the projection. Immutable.
 *  A frozen (terminal) projection ignores everything. */
export function reduceWorkItem(
  projection: WorkTurnProjection,
  item: ConversationItem,
  opts?: ReduceOptions,
): WorkTurnProjection {
  if (projection.terminal !== undefined) return projection;
  // A `conversation` turn answers directly (spec §2.1): it must
  // never build phases / activities / blockers. Only a terminal
  // presentation lands on it.
  if (projection.identity.intent === "conversation") {
    return reduceConversationItem(projection, item);
  }
  const at = (opts?.now ?? Date.now)();
  let next = projection;

  switch (item.kind) {
    case "plan": {
      next = ensurePhase(next, inferPhase(item), at);
      next = withPhaseStatus(next, inferPhase(item), item.stage === "started" ? "active" : "completed", at);
      break;
    }
    case "tool": {
      const activity = inferActivity(item, at);
      if (!activity) break;
      next = upsertActivity(next, activity, at);
      next = ensurePhase(next, activity.phase, at);
      break;
    }
    case "progress": {
      // Command output routed to a running tool: fold it into
      // that activity as evidence instead of spamming the
      // timeline (spec §6.3 / §4.4 "command stdout 默认折叠").
      if (item.toolCallId) {
        next = attachProgress(next, item.toolCallId, item.text, item.phaseId, at);
      } else {
        // Run-level recovery/progress has no tool owner. Keep one concise
        // narration in the active phase so a retry is visible without adding
        // another card or polluting the final-answer fallback.
        const phase =
          findActivePhase(next.phases)?.phase ??
          lastOpenPhase(next.phases)?.phase ??
          inferPhase(item);
        next = ensurePhase(next, phase, at);
        next = withNarration(next, phase, item.text, "derived", at);
        if (/重试|恢复|retry|recover/i.test(item.text)) {
          next = { ...next, state: "recovering" };
        }
      }
      break;
    }
    case "thinking": {
      // Reasoning belongs to the phase the run is currently in. Routing every
      // thought through inferPhase() sent them all to `understand` (its
      // fallback for non-tool items), which both mis-filed the narration and —
      // while narration ids were still per-phase — made all of them collapse
      // into a single line.
      // Prefer the genuinely active phase, then the most recently opened
      // unfinished one. Falling straight through to inferPhase() is what
      // labelled every single line "understand" (see lastOpenPhase()).
      const phase =
        findActivePhase(next.phases)?.phase ??
        lastOpenPhase(next.phases)?.phase ??
        inferPhase(item);
      next = ensurePhase(next, phase, at);
      next = withNarration(next, phase, item.text, "timeline", at);
      break;
    }
    case "artifact": {
      const activity: WorkActivity = {
        id: item.id,
        runId: item.runId,
        phase: "deliver",
        kind: "artifact",
        summary: item.filePath,
        status: "completed",
        evidence: [{ label: "产物位置", detail: item.filePath }],
        startedAt: at,
        finishedAt: at,
        toolMessageId: item.id,
      };
      next = ensurePhase(next, "deliver", at);
      next = mergeOrAppendActivity(next, activity, at);
      next = withPhaseStatus(next, "deliver", "completed", at);
      break;
    }
    case "approval": {
      if (item.status === "pending") {
        next = withBlocker(next, {
          kind: "approval",
          id: item.approvalId,
          label: item.description || "权限请求",
          itemId: item.id,
        });
      } else if (item.status === "approved" || item.status === "denied") {
        next = withoutBlocker(next, "approval", item.approvalId);
      }
      break;
    }
    case "input_request": {
      if (item.status === "pending") {
        const title = item.questions[0]?.question
          ?? item.questions[0]?.header
          ?? "需要你的选择";
        next = withBlocker(next, {
          kind: "input",
          id: item.requestId,
          label: title,
          itemId: item.id,
        });
      } else if (item.status === "submitted" || item.status === "dismissed") {
        next = withoutBlocker(next, "input", item.requestId);
      }
      break;
    }
    case "final": {
      const terminal: WorkTerminalPresentation = {
        kind: "final_answer",
        text: item.text,
      };
      next = {
        ...next,
        terminal,
        state: "final_answer",
        phases: settlePhases(next.phases, at),
      };
      break;
    }
    case "error": {
      const terminal: WorkTerminalPresentation = {
        kind: "error",
        message: item.userMessage,
        diagnosticId: item.diagnosticId,
      };
      next = {
        ...next,
        terminal,
        state: "error",
        phases: settlePhases(next.phases, at),
      };
      break;
    }
    case "cancelled": {
      next = {
        ...next,
        terminal: { kind: "cancelled", message: item.text },
        state: "cancelled",
        phases: settlePhases(next.phases, at),
      };
      break;
    }
    default:
      // diagnostics and anything else carry no timeline meaning.
      break;
  }
  return finalizeProjection(next);
}

/** Reflect a task status outside the item stream (e.g. from the
 *  reconciler's task.get) onto the projection. Terminal statuses
 *  freeze it; non-terminal statuses reroute recovering etc. */
export function reduceTaskStatus(
  projection: WorkTurnProjection,
  status: string,
  _opts?: ReduceOptions,
): WorkTurnProjection {
  if (status === "running" || status === "starting" || status === "pending") {
    const state = resolveRunningState(projection);
    return state === projection.state
      ? projection
      : finalizeProjection({ ...projection, state });
  }
  if (isTaskTerminal(status as TaskStatus)) {
    // The reconciler confirmed terminal but produced no final
    // item yet. We only anchor the terminal state here; the
    // result resolver (WP-3) supplies the presentation text.
    const already = projection.terminal;
    if (already !== undefined) return projection;
    if (status === "failed") {
      return finalizeProjection({
        ...projection,
        terminal: {
          kind: "error",
          message: projection.identity.intent === "conversation"
            ? "未能回复"
            : "任务执行失败",
          diagnosticId: `terminal:${projection.identity.runId}`,
        },
        state: "error",
      });
    }
    if (status === "cancelled") {
      return finalizeProjection({
        ...projection,
        terminal: { kind: "cancelled", message: "任务已取消" },
        state: "cancelled",
      });
    }
  }
  return projection;
}

/** Conversation turns answer directly and build NO task
 *  scaffolding (spec §2.1 / §3.1). Only a terminal presentation
 *  is folded in; every other item is ignored so a chat turn
 *  never yields a PhaseRail, activities or blockers. */
function reduceConversationItem(
  projection: WorkTurnProjection,
  item: ConversationItem,
): WorkTurnProjection {
  switch (item.kind) {
    case "final":
      return finalizeProjection({
        ...projection,
        terminal: { kind: "final_answer", text: item.text },
        state: "final_answer",
      });
    case "error":
      return finalizeProjection({
        ...projection,
        terminal: { kind: "error", message: item.userMessage, diagnosticId: item.diagnosticId },
        state: "error",
      });
    case "cancelled":
      return finalizeProjection({
        ...projection,
        terminal: { kind: "cancelled", message: item.text },
        state: "cancelled",
      });
    default:
      return projection;
  }
}

/** Derive the present work turn state from the projection
 *  facts (spec §3). The stored `state` is recomputed here on
 *  every change so blockers / active phases stay authoritative. */
export function deriveTurnState(projection: WorkTurnProjection): WorkTurnState {
  if (projection.terminal !== undefined) return projection.terminal.kind;
  if (projection.identity.intent === "conversation") return "answering";
  for (const b of projection.blockers) {
    if (b.kind === "approval") return "awaiting_approval";
    if (b.kind === "input") return "awaiting_input";
  }
  const active = findActivePhase(projection.phases);
  if (!active) return "understanding";
  switch (active.phase) {
    case "understand": return "understanding";
    case "explore": return "planning";
    case "execute": return "executing";
    case "verify": return "verifying";
    case "deliver": return "finalizing";
  }
}

/** Deterministic template narration fallback (spec §5.4).
 *  Uses ONLY facts already observed in the projection — never
 *  invents file names, counts or verification verdicts. */
export function derivePhaseNarration(
  projection: WorkTurnProjection,
  phase: WorkSemanticPhase,
): string {
  const same = projection.activities.filter((a) => a.phase === phase);
  const reads = same.filter((a) => a.kind === "file_read").reduce((n, a) => n + (a.batch ?? 1), 0);
  const writes = same.filter((a) => a.kind === "file_write" || a.kind === "file_edit");
  switch (phase) {
    case "understand":
      return reads > 0
        ? `已读取 ${reads} 个资料文件，正在整理主要信息。`
        : "正在理解任务目标。";
    case "explore":
      return `已完成资料查找${reads > 0 ? `（读取 ${reads} 个文件）` : ""}。`;
    case "execute":
      return writes.length > 0
        ? "已确定输出结构，正在生成与补充内容。"
        : "正在执行具体改动。";
    case "verify":
      return "正在检查格式与引用。";
    case "deliver":
      return "已产出结果，正在收尾。";
  }
}

/** True when the turn has any realized phase (used by the
 *  PhaseRail renderer to decide whether to show a rail at all —
 *  a conversation must render none). */
export function shouldRenderPhaseRail(projection: WorkTurnProjection): boolean {
  return projection.identity.intent === "task" && projection.phases.length > 0;
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function finalizeProjection(next: WorkTurnProjection): WorkTurnProjection {
  // WP-6 (duplicate-event idempotence): deriving the SAME state must
  // not mint a new projection object — task.events replays re-apply
  // the whole tail, and every consumer compares by reference.
  const state = deriveTurnState(next);
  return state === next.state ? next : { ...next, state };
}

function findActivePhase(phases: readonly WorkPhaseState[]): WorkPhaseState | undefined {
  return phases.find((p) => p.status === "active");
}

/**
 * Most recently OPENED phase that has not finished.
 *
 * Needed because phases are created as `pending` and only ever flip to
 * `active` via the `plan` branch (which immediately marks them `completed`
 * once the plan finishes). The `tool` branch only calls ensurePhase(), so in
 * practice a run almost never has an `active` phase and every narration fell
 * back to `understand` — the panel showed a long list of identically-labelled
 * "understand" lines even while the agent was executing or verifying.
 *
 * `phases` is stored in SEMANTIC order (understand → explore → execute →
 * verify → deliver), not opening order, so this compares openedAt rather than
 * taking the last element.
 */
function lastOpenPhase(phases: readonly WorkPhaseState[]): WorkPhaseState | undefined {
  let best: WorkPhaseState | undefined;
  for (const phase of phases) {
    if (phase.status === "completed" || phase.status === "failed") continue;
    if (!best || (phase.openedAt ?? 0) >= (best.openedAt ?? 0)) {
      best = phase;
    }
  }
  return best;
}

function resolveRunningState(p: WorkTurnProjection): WorkTurnState {
  const d = deriveTurnState(p);
  return isTerminalTurnState(d) ? "executing" : d;
}

function phaseIndex(phase: WorkSemanticPhase): number {
  return WORK_SEMANTIC_PHASES.indexOf(phase);
}

function ensurePhase(
  p: WorkTurnProjection,
  phase: WorkSemanticPhase,
  at: number,
): WorkTurnProjection {
  if (p.phases.some((x) => x.phase === phase)) return p;
  const row: WorkPhaseState = {
    phase,
    status: "pending",
    label: WORK_PHASE_LABELS[phase],
    activityCount: 0,
    openedAt: at,
  };
  const phases = [...p.phases, row].sort((a, b) => phaseIndex(a.phase) - phaseIndex(b.phase));
  return { ...p, phases };
}

function withPhaseStatus(
  p: WorkTurnProjection,
  phase: WorkSemanticPhase,
  status: WorkPhaseState["status"],
  at: number,
): WorkTurnProjection {
  const idx = p.phases.findIndex((x) => x.phase === phase);
  if (idx === -1) return p;
  const current = p.phases[idx];
  if (!current) return p;
  if (current.status === status) return p;
  const phases = p.phases.slice();
  phases[idx] = {
    ...current,
    status,
    openedAt: status === "active" ? (current.openedAt ?? at) : current.openedAt,
    closedAt: status === "completed" || status === "failed" ? at : current.closedAt,
  };
  return { ...p, phases };
}

/** Mark every still-open phase as closed and strip running
 *  state when the run lands terminal (spec §4.4 / §10.4: the
 *  spinner / animation must not keep spinning after final). */
function settlePhases(
  phases: readonly WorkPhaseState[],
  at: number,
): readonly WorkPhaseState[] {
  return phases.map((p) =>
    p.status === "active"
      ? { ...p, status: "completed", closedAt: at }
      : p.status === "pending"
        ? { ...p, status: "completed", closedAt: at }
        : p,
  );
}

function upsertActivity(
  p: WorkTurnProjection,
  activity: WorkActivity,
  at: number,
): WorkTurnProjection {
  const idx = p.activities.findIndex((a) => a.id === activity.id);
  if (idx === -1) {
    return mergeOrAppendActivity(p, activity, at);
  }
  const existing = p.activities[idx];
  if (!existing) return p;
  if (existing.status === activity.status && activity.status !== "running") {
    return p; // duplicate terminal write → no-op
  }
  // WP-6 (§11.2 恰好一次): a replayed running-state write carries
  // no new fact — treat it as a duplicate too, otherwise task.events
  // replays churn the projection (and every consumer) on each pass.
  if (existing.status === "running" && activity.status === "running"
    && existing.summary === activity.summary) {
    return p;
  }
  // WP-6 late/out-of-order event: a running write that arrives
  // after the activity already reached a terminal state must never
  // regress it (replays re-emit the whole tail in order).
  if (activity.status === "running"
    && (existing.status === "completed" || existing.status === "failed")) {
    return p;
  }
  const activities = p.activities.slice();
  activities[idx] = {
    ...existing,
    ...activity,
    evidence: activity.evidence.length > 0 ? activity.evidence : existing.evidence,
    startedAt: existing.startedAt ?? activity.startedAt,
    finishedAt: activity.status === "completed" || activity.status === "failed"
      ? at
      : existing.finishedAt,
  };
  return { ...p, activities };
}

/** Append a completed activity, or merge it into the previous
 *  same-kind+phase completed activity inside BATCH_WINDOW_MS
 *  (spec §4.4 — "读取 6 个文件" instead of six identical rows). */
function mergeOrAppendActivity(
  p: WorkTurnProjection,
  activity: WorkActivity,
  at: number,
): WorkTurnProjection {
  if (activity.status === "completed" && p.activities.length > 0) {
    const prev = p.activities[p.activities.length - 1];
    if (
      prev &&
      prev.kind === activity.kind &&
      prev.phase === activity.phase &&
      prev.status === "completed" &&
      at - prev.startedAt <= BATCH_WINDOW_MS
    ) {
      const activities = p.activities.slice();
      activities[activities.length - 1] = {
        ...prev,
        batch: (prev.batch ?? 1) + 1,
        finishedAt: at,
        evidence: activity.evidence.length > 0 ? activity.evidence : prev.evidence,
      };
      return bumpPhaseCount({ ...p, activities }, activity.phase);
    }
  }
  return bumpPhaseCount(
    { ...p, activities: [...p.activities, activity] },
    activity.phase,
  );
}

function bumpPhaseCount(
  p: WorkTurnProjection,
  phase: WorkSemanticPhase,
): WorkTurnProjection {
  const idx = p.phases.findIndex((x) => x.phase === phase);
  if (idx === -1) return p;
  const current = p.phases[idx];
  if (!current) return p;
  const phases = p.phases.slice();
  phases[idx] = { ...current, activityCount: current.activityCount + 1 };
  return { ...p, phases };
}

/** Route a `progress` (command output) into the running tool
 *  activity that shares its toolCallId; otherwise ignore it
 *  (it lives in Diagnostics already and must not spam). */
function attachProgress(
  p: WorkTurnProjection,
  toolCallId: string,
  text: string,
  _phaseId: string | undefined,
  _at: number,
): WorkTurnProjection {
  const idx = p.activities.findIndex(
    (a) => a.toolCallId === toolCallId && a.status === "running",
  );
  if (idx === -1) return p;
  const activities = p.activities.slice();
  const a = activities[idx];
  if (!a) return p;
  activities[idx] = {
    ...a,
    evidence: [...a.evidence, { label: text.slice(0, 120) }].slice(-3),
  };
  return finalizeProjection({ ...p, activities });
}

/**
 * Narration ids are keyed on (phase, text) instead of (phase).
 *
 * The previous id — `narration:<runId>:<phase>` — meant every new line for a
 * phase OVERWROTE the previous one. Measured on the recorded runs: 318
 * `thinking` items collapsed to 11 narrations (exactly one per run in most
 * cases), and because the daemon's last `progress_update` ("All steps
 * completed") also lands in that phase, the only surviving line was that
 * English progress string. That is why the panel ended with "All steps
 * completed" and showed no reasoning at all.
 *
 * Keying on the text keeps replays idempotent (WP-6: the same line yields the
 * same id and updates in place) while letting distinct thoughts accumulate.
 */
/**
 * Narration identity is the TEXT, deliberately NOT (phase + text).
 *
 * Keying on the phase broke WP-6 idempotence: the phase is derived from how
 * many phases happen to be open when the line is folded in, so a replay of the
 * same tail resolved the same line to a different phase, minted a different
 * id and appended a duplicate instead of updating in place.
 *
 * The phase is still stored on the entry (`phaseId`) and is what the UI groups
 * by — it simply no longer participates in identity.
 */
function narrationId(runId: string, text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `narration:${runId}:${(hash >>> 0).toString(36)}`;
}

/** Drop the oldest lines of a phase once it exceeds the cap, preserving the
 *  original ordering of everything that survives. */
function capNarrationsPerPhase(
  narrations: readonly WorkNarrationMessage[],
  maxPerPhase: number,
): readonly WorkNarrationMessage[] {
  const counts = new Map<string, number>();
  const kept: WorkNarrationMessage[] = [];
  // Walk backwards so we keep the most recent lines of each phase.
  for (let i = narrations.length - 1; i >= 0; i -= 1) {
    const n = narrations[i];
    if (!n) continue;
    const key = String(n.phaseId);
    const seen = counts.get(key) ?? 0;
    if (seen >= maxPerPhase) continue;
    counts.set(key, seen + 1);
    kept.unshift(n);
  }
  return kept;
}

function withNarration(
  p: WorkTurnProjection,
  phase: WorkSemanticPhase,
  text: string,
  source: WorkNarrationMessage["source"],
  _at: number,
): WorkTurnProjection {
  const clean = text.trim();
  if (clean.length === 0) return p;
  const id = narrationId(p.identity.runId, clean);
  const existing = p.narrations.find((n) => n.id === id);
  const narration: WorkNarrationMessage = {
    id,
    runId: p.identity.runId,
    phaseId: phase,
    text: clean,
    source,
    partial: true,
  };
  if (existing) {
    // WP-6: re-applying an identical line must not mint a new object.
    if (existing.text === clean && existing.source === source) return p;
    return { ...p, narrations: p.narrations.map((n) => (n.id === id ? narration : n)) };
  }
  const merged = [...p.narrations, narration];
  return { ...p, narrations: capNarrationsPerPhase(merged, MAX_NARRATIONS_PER_PHASE) };
}

function withBlocker(
  p: WorkTurnProjection,
  blocker: WorkBlocker,
): WorkTurnProjection {
  return p.blockers.some((b) => b.id === blocker.id)
    ? p
    : { ...p, blockers: [...p.blockers, blocker] };
}

function withoutBlocker(
  p: WorkTurnProjection,
  kind: WorkBlocker["kind"],
  id: string,
): WorkTurnProjection {
  return p.blockers.some((b) => b.kind === kind && b.id === id)
    ? { ...p, blockers: p.blockers.filter((b) => !(b.kind === kind && b.id === id)) }
    : p;
}

/** Map one ConversationItem to a WorkActivity, or null when it
 *  has no timeline meaning (diagnostics, planning markers). */
export function inferActivity(item: ConversationItem, at: number): WorkActivity | null {
  if (item.kind !== "tool") return null;
  const phase = inferPhase(item);
  const status = item.status === "done"
    ? "completed"
    : item.status === "error" || item.status === "interrupted"
      ? "failed"
      : "running";
  return {
    id: item.id,
    runId: item.runId,
    phase,
    kind: classifyToolKind(item.tool),
    summary: item.summary || item.tool,
    status,
    evidence: [],
    startedAt: at,
    toolCallId: item.toolCallId,
    toolMessageId: item.id,
    finishedAt: status === "completed" || status === "failed" ? at : undefined,
  };
}

/** Semantic phase for a single item (spec §7.2 mapping).
 *  Accepts any ConversationItem (or a structural subset). */
export function inferPhase(item: {
  kind?: string;
  phaseId?: string;
  tool?: string;
  name?: string;
}): WorkSemanticPhase {
  if (item.kind === "artifact") return "deliver";
  if (item.kind === "tool" && item.tool) {
    switch (classifyToolKind(item.tool)) {
      case "file_read":
      case "file_delete":
      case "code_search":
      case "web_search":
      case "browser":
        return "explore";
      case "file_write":
      case "file_edit":
      case "command":
        return "execute";
      case "verification":
        return "verify";
      default:
        break;
    }
    return classifyToolKind(item.tool) === "artifact" ? "deliver" : "execute";
  }
  // Agent narration / other → understand unless a tool hints.
  return "understand";
}

/** Classify a raw tool name into a WorkActivityKind. Word-match
 *  on the daemon / vendor tool identifiers, with an aggregate
 *  fallback so unrecognised names never throw. */
export function classifyToolKind(tool: string): WorkActivityKind {
  const t = tool.toLowerCase();
  if (/(^|_|\.)(read|cat|glance)/.test(t)) return "file_read";
  // ── Work document agent ────────────────────────────────────────────────
  // These names are what the daemon actually emits (measured over the
  // recorded runs: list_directory 48, read_file 44, grep 44,
  // parse_document 26, glob 6, get_file_info 4, create_spreadsheet 4).
  // None of them contain a "read"/"write" token, so every one of them used to
  // fall through to `other` and the UI could only show a meaningless
  // "操作 N". Parsing/reading a document is a READ and must be tested BEFORE
  // the artifact rule below, which also matches "document".
  if (/parse_document|read_document|extract_text|parse_pdf|parse_/.test(t)) return "file_read";
  if (/list_directory|list_dir|get_file_info|stat_file|file_info/.test(t)) return "file_read";
  if (/(^|_|\.|)(write|file_write|create_file|overwrite)/.test(t) && /write|create/.test(t)) return "file_write";
  if (/create_directory|make_dir|mkdir/.test(t)) return "file_write";
  if (/edit|patch|insert|replace/.test(t)) return "file_edit";
  if (/delete|rm|remove/.test(t)) return "file_delete";
  if (/glob|list_files|find_files|grep|search|code_search|find|rg/.test(t)) return "code_search";
  if (/web_search|search_web|perplexity/.test(t)) return "web_search";
  if (/bash|command|shell|run|execute|exec|terminal|npx|npm|pnpm/.test(t)) return "command";
  if (/browser|navigate|open_url|playwright/.test(t)) return "browser";
  if (/verify|validate|test|lint|check|qa|assert/.test(t)) return "verification";
  if (/memory|remember|recall/.test(t)) return "memory";
  // Artifact generators (spreadsheets, documents, slides) are the Work
  // deliverables. Tested after the read rules so "parse_document" stays a
  // read and "create_spreadsheet" becomes a deliverable.
  if (/spreadsheet|xlsx|excel|docx|pptx|presentation|slide|artifact|generator|generate_/.test(t)) return "artifact";
  if (/agent|subagent|delegate|fork/.test(t)) return "agent";
  return "other";
}
