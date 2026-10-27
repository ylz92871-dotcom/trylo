/**
 * Project CLI `subagent` lifecycle events for the five Team seats
 * into a TeamRun. Person chat must not render these — applyEvents
 * skips the same ids; this module is the only consumer.
 *
 * P0: prompt / result / status. Per-seat tool timelines stay later.
 */
import { isTeamSeatId } from '../shared/seats';
import { assignmentText, recordMemberProgress, recordTeamHandoff } from './team-progress-projection';
import { recordMemberObservation } from '../../domain/member-observation';
import type { ContractSummaryLike } from '../shared/engineering-contract';
import {
  applySeatPatch,
} from './team-store';
import type {
  SeatActivityItem,
  SeatInstance,
  SeatRunStatus,
  TaskSummary,
  TeamRun,
  TeamRunStatus,
} from './team-types';

export interface TeamProjectionContext {
  readonly teamRunId?: string;
  readonly workspaceId: string;
  readonly personConversationId: string;
}

export interface TeamSubagentEvent {
  readonly observation?: import('../../domain/member-observation').MemberObservation;
  readonly taskId?: string;
  readonly canReceiveInput?: boolean;
  readonly parked?: boolean;
  readonly round?: number;
  readonly activity?: import('../../host-adapter/subagent-contract').SubagentToolActivity;
  readonly type: 'subagent';
  readonly kind: 'spawn' | 'update' | 'end';
  readonly id: string;
  readonly agentType?: string;
  /** Member instance uuid forwarded from the AgentTool `member_id` field
   *  (Foundation spec §8.2). Spawn events only; end events match on id. */
  readonly memberId?: string;
  readonly teamRunId?: string;
  readonly source?: 'trylo-v1';
  readonly status?: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
  readonly error?: string;
  readonly resumedFrom?: string;
  readonly prompt?: string;
  readonly result?: string;
  readonly durationMs?: number;
  readonly ts?: number;
  /** CLI may attach contract identity later (spec §14.7); optional v0. */
  readonly contractId?: string;
  readonly contractVersion?: number;
}

/**
 * App-computed flags folded into the projection. The projection NEVER
 * parses seat output itself (spec §10.4: parsing lives in
 * user-learning + App wiring; surfaces only consume the verdict).
 */
export interface TeamEventExtras {
  readonly vetoActive?: boolean;
  readonly vetoReason?: string;
  /** Contract summary for TaskSummary rows; from the App's prepared contract. */
  readonly contractSummary?: ContractSummaryLike;
}

const SUMMARY_MAX = 24;
const ONELINER_MAX = 80;
const ACTIVITY_MAX = 24;

function clamp(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function isTeamSubagentEvent(event: unknown, run: TeamRun): event is TeamSubagentEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as { type?: unknown; kind?: unknown; id?: unknown; agentType?: unknown;
    source?: unknown; teamRunId?: unknown; memberId?: unknown };
  if (e.type !== 'subagent') return false;
  if (e.kind !== 'spawn' && e.kind !== 'update' && e.kind !== 'end') return false;
  if (typeof e.id !== 'string' || e.id.length === 0) return false;
  if (e.teamRunId !== undefined && e.teamRunId !== run.id) return false;
  if (e.kind !== 'spawn') return run.seats.some(seat => seat.id === e.id);
  // A role name alone is also valid for ordinary V1 children. Only the
  // frozen run/member identity may route one onto the team stage.
  if (e.source === 'trylo-v1' && (e.teamRunId !== run.id || typeof e.memberId !== 'string')) return false;
  return isTeamSeatId(typeof e.agentType === 'string' ? e.agentType : '');
}

function deriveTeamStatus(seats: readonly SeatInstance[]): TeamRunStatus {
  if (seats.some(s => s.status === 'running')) return 'running';
  if (seats.some(s => s.status === 'waiting_approval')) return 'waiting';
  if (seats.some(s => s.status === 'queued')) return 'running';
  if (seats.length === 0) return 'running';
  if (seats.some(s => s.status === 'failed')) return 'failed';
  if (seats.every(s => s.status === 'completed' || s.status === 'cancelled')) {
    return seats.some(s => s.status === 'cancelled') ? 'cancelled' : 'completed';
  }
  return 'running';
}

function withDerivedStatus(run: TeamRun): TeamRun {
  const status = deriveTeamStatus(run.seats);
  if (status === run.status) return run;
  return { ...run, status, updatedAt: Date.now() };
}

/** ContractSummaryLike → TaskSummary (spec §8.4). Field names match; the
 *  clamp mirrors the fixture so the hero card shows all three rows. */
export function taskSummaryFromSummaryDto(dto: ContractSummaryLike): TaskSummary {
  return {
    title: clamp(dto.title || 'Team', SUMMARY_MAX),
    goal: dto.goal,
    oneLiner: clamp(dto.oneLiner || dto.goal, ONELINER_MAX),
    ...(dto.explicit ? { explicit: dto.explicit } : {}),
    ...(dto.inferred ? { inferred: dto.inferred } : {}),
    ...(dto.baseline ? { baseline: dto.baseline } : {}),
  };
}

function applySpawn(
  run: TeamRun,
  event: TeamSubagentEvent,
  ctx: TeamProjectionContext,
  extras?: TeamEventExtras,
): TeamRun {
  void ctx;
  void extras;
  const prompt = event.prompt ?? '';
  const patch = {
    status: 'running' as const,
    summary: clamp(prompt || (event.agentType ?? 'seat'), SUMMARY_MAX),
    ...(prompt ? { prompt } : {}),
    ...(event.ts !== undefined ? { startedAt: event.ts } : {}),
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.canReceiveInput === undefined ? {} : { canReceiveInput: event.canReceiveInput }),
    parked: false,
    awaitingInput: false,
  };
  // Stdout and the event tail can deliver the same spawn. A replay must
  // never reset progress or revive a terminal member.
  if (run.seats.some(s => s.id === event.id)) return run;
  const recovered = event.source === 'trylo-v1' && event.teamRunId === run.id && event.resumedFrom !== undefined
    ? run.seats.find(seat => seat.id === event.resumedFrom && seat.memberId === event.memberId && seat.seat === event.agentType)
    : undefined;
  if (recovered && run.endedAt === undefined) {
    return withDerivedStatus(applySeatPatch(run, recovered.id, {
      ...patch, ...roundPatch(recovered, event), id: event.id, result: undefined, error: undefined, endedAt: undefined, durationMs: undefined,
    }));
  }
  // Foundation spec §7.6.3 — bind the spawn onto a QUEUED row from the
  // frozen profile when one exists:
  //   1. exact memberId hit, 2. FIFO unused queued row of this baseRole.
  // End events only carry the tool_use id, so binding here is what makes
  // them resolvable (and keeps two workers from swapping overlays).
  const queued = run.seats.find(
    (s) => s.status === 'queued' &&
      (event.memberId !== undefined
        ? s.memberId === event.memberId && s.seat === event.agentType
        : false),
  )
    ?? (event.memberId === undefined ? run.seats.find(
      (s) => s.status === 'queued' && s.seat === event.agentType,
    ) : undefined);
  if (queued) {
    return withDerivedStatus(applySeatPatch(run, queued.id, {
      ...patch,
      ...roundPatch(queued, event),
      id: event.id,
      ...(event.memberId !== undefined && queued.memberId === undefined
        ? { memberId: event.memberId }
        : {}),
    }));
  }
  // No queued row to bind (PA spawned something outside the freeze) —
  // drop it rather than append a phantom row.
  return run;
}

function applyEnd(run: TeamRun, event: TeamSubagentEvent, extras?: TeamEventExtras): TeamRun {
  const existing = run.seats.find(s => s.id === event.id);
  if (!existing) return run;
  const result = event.result;
  const facts = { ...roundPatch(existing, event), awaitingInput: false, canReceiveInput: event.canReceiveInput === true && event.parked === true,
    parked: event.parked === true };
  if (existing.status === 'cancelled') {
    return withDerivedStatus(
      applySeatPatch(run, event.id, {
        ...facts,
        ...(result !== undefined ? { result } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.ts !== undefined ? { endedAt: event.ts } : {}),
      }),
    );
  }
  // Person veto keeps the seat at waiting_approval so deriveTeamStatus
  // yields 'waiting' and the status bar stays visible (spec §10.4 /
  // Key Decision 16). Without extras the legacy completed path holds.
  if (existing.seat === 'person' && extras?.vetoActive) {
    const reason = (extras.vetoReason ?? '').replace(/\s+/g, ' ').trim();
    return withDerivedStatus(
      applySeatPatch(run, event.id, {
        ...facts,
        status: 'waiting_approval' as const,
        summary: clamp(`Person 否决 · ${reason}`.trim(), SUMMARY_MAX),
        ...(result !== undefined ? { result } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.ts !== undefined ? { endedAt: event.ts } : {}),
      }),
    );
  }
  const status: SeatRunStatus = event.status === 'failed' ? 'failed'
    : event.status === 'cancelled' ? 'cancelled' : 'completed';
  const summary = result ? clamp(result, SUMMARY_MAX) : existing.summary;
  return withDerivedStatus(
    applySeatPatch(run, event.id, {
      ...facts,
      status,
      summary,
      ...(event.error !== undefined ? { error: event.error } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.ts !== undefined ? { endedAt: event.ts } : {}),
    }),
  );
}

function applyUpdate(run: TeamRun, event: TeamSubagentEvent, extras?: TeamEventExtras): TeamRun {
  const seat = run.seats.find(value => value.id === event.id);
  if (!seat) return run;
  let next = applySeatPatch(run, event.id, {
    ...roundPatch(seat, event),
    ...(event.observation === undefined ? {} : { observations: recordMemberObservation(seat.observations, event.observation, event.ts ?? Date.now()) }),
    ...(event.round !== undefined && event.round > (seat.round ?? 1) ? { result: undefined, error: undefined,
      summary: clamp(event.prompt ? assignmentText(event.prompt) : '正在执行下一步', SUMMARY_MAX) } : {}),
    ...(event.status === 'waiting' ? { awaitingInput: true } : event.status === 'running' ? { awaitingInput: false } : {}),
    ...(event.status === 'running' ? { status: 'running', parked: false } : {}),
    ...(event.result !== undefined ? { result: event.result, summary: clamp(event.result, SUMMARY_MAX) } : {}),
    ...(extras?.vetoActive && seat.seat === 'person'
      ? { status: 'waiting_approval', summary: clamp(`Person 否决 · ${extras.vetoReason ?? ''}`, SUMMARY_MAX) } : {}),
  });
  const activity = event.activity;
  if (activity) {
    const label = seat.activity?.find(item => item.id === activity.id)?.label ?? labelSeatTool(activity.tool ?? 'tool');
    const ok = activity.kind === 'result' ? activity.ok : undefined;
    next = withActivity(next, seat.id, { id: activity.id, kind: activity.kind, label, round: event.round ?? seat.round ?? 1,
      at: event.ts ?? Date.now(), ...(ok === undefined ? {} : { ok }) }, ok === false ? `${label}失败` : label);
  }
  return withDerivedStatus(next);
}

function roundPatch(seat: SeatInstance, event: TeamSubagentEvent): { readonly round?: number; readonly conversation?: SeatInstance['conversation'] } {
  if (event.prompt === undefined && event.result === undefined && event.round === undefined) return {};
  const round = event.round ?? seat.round ?? 1;
  const conversation = [...(seat.conversation ?? [])];
  const index = conversation.findIndex(value => value.round === round);
  const previous = index < 0 ? undefined : conversation[index];
  const entry = { ...previous, round,
    ...(event.prompt !== undefined && (event.kind === 'spawn' || previous?.prompt === undefined) ? { prompt: event.prompt } : {}),
    ...(event.result === undefined ? {} : { result: event.result }) };
  if (index < 0) conversation.push(entry); else conversation[index] = entry;
  return { round, conversation: conversation.slice(-64) };
}

/** Optimistic local cancel. The CLI `stop_task` follows from App. */
export function cancelTeamSeat(run: TeamRun, seatId: string, at = Date.now()): TeamRun {
  const existing = run.seats.find(s => s.id === seatId);
  if (!existing) return run;
  if (existing.status !== 'running' && existing.status !== 'waiting_approval' && existing.status !== 'queued') {
    return run;
  }
  const durationMs =
    existing.startedAt !== undefined ? Math.max(0, at - existing.startedAt) : existing.durationMs;
  return withDerivedStatus(
    applySeatPatch(run, seatId, {
      status: 'cancelled',
      endedAt: at,
      error: '席位已取消。',
      ...(durationMs !== undefined ? { durationMs } : {}),
    }),
  );
}

/**
 * Fold a batch of loop events into the projected run (Foundation spec
 * §7.6.3): spawn events BIND onto the queued rows the launch froze —
 * events may never materialize a run out of thin air. The run reference
 * is the App-selected projection for THIS conversation (launch-created);
 * mismatches and terminal runs are ignored.
 */
export function applyTeamEvents(
  run: TeamRun | null,
  events: readonly unknown[],
  ctx: TeamProjectionContext,
  extras?: TeamEventExtras,
): TeamRun | null {
  let next = run;
  let touched = false;
  for (const event of events) {
    if (!next || next.personConversationId !== ctx.personConversationId || next.workspaceId !== ctx.workspaceId) {
      continue;
    }
    const settled = settleParentEnd(next, event);
    if (settled !== next) {
      next = { ...settled, ...(settled.reports ? { reports: settled.reports.map(report => report.streaming ? { ...report, streaming: false } : report) } : {}) };
      touched = true;
      continue;
    }
    if (next.endedAt !== undefined) continue;
    const terminal = next.status === 'completed' || next.status === 'failed' || next.status === 'cancelled';
    if (terminal && next.lifecycle !== 'open') continue;
    if (isTeamSubagentEvent(event, next)) {
      const before = next;
      next = event.kind === 'spawn'
        ? applySpawn(next, event, ctx, extras)
        : event.kind === 'end' ? applyEnd(next, event, extras) : applyUpdate(next, event, extras);
      next = recordMemberProgress(before, next, event);
      touched = true;
      continue;
    }
    const withTool = applyToolEvent(recordTeamHandoff(next, event), event);
    if (withTool !== next) {
      next = withTool;
      touched = true;
    }
  }
  return touched ? next : run;
}

function settleParentEnd(run: TeamRun, event: unknown): TeamRun {
  if (run.endedAt !== undefined) return run;
  if (!event || typeof event !== 'object') return run;
  const e = event as { type?: unknown; reason?: unknown; isError?: unknown; error?: unknown; ts?: unknown };
  if (e.type !== 'loop_end') return run;
  const cancelled = e.reason === 'cancelled' || e.reason === 'aborted' || e.reason === 'user_interrupt';
  const at = typeof e.ts === 'number' ? e.ts : Date.now();
  const seats = run.seats.map(seat => seat.status === 'queued' || seat.status === 'running' || seat.status === 'waiting_approval'
    ? { ...seat, status: cancelled ? 'cancelled' as const : 'failed' as const, endedAt: at,
      error: cancelled ? seat.error : e.reason === 'startup_failed' && typeof e.error === 'string' ? e.error
        : seat.error ?? (seat.status === 'queued' ? '父任务结束前未派发该成员。' : '父任务结束前未收到成员终态。') }
    : seat);
  const status = cancelled ? 'cancelled' : e.isError === true ? 'failed' : deriveTeamStatus(seats);
  return { ...run, seats: seats.map(seat => ({ ...seat, canReceiveInput: false })), status, lifecycle: 'closed', updatedAt: at, endedAt: at };
}

function fileNameFrom(input: Readonly<Record<string, unknown>> | undefined): string {
  if (!input) return '';
  const raw = input['file_path'] ?? input['path'] ?? input['filePath'] ?? input['target_file'];
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const parts = raw.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export function labelSeatTool(tool: string, input?: Readonly<Record<string, unknown>>): string {
  const file = fileNameFrom(input);
  switch (tool) {
    case 'Read':
    case 'read_file': return file ? `读 ${file}` : '读文件';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': return file ? `改 ${file}` : '改文件';
    case 'write_file':
    case 'edit_file':
    case 'apply_patch': return file ? `改 ${file}` : '改文件';
    case 'Bash':
    case 'PowerShell':
    case 'run_shell': return '命令';
    case 'Grep':
    case 'Glob':
    case 'search_text':
    case 'find_files': return '搜索';
    case 'WebFetch':
    case 'WebSearch': return '检索';
    case 'Agent': return '派出成员';
    default: return tool;
  }
}

function findSeatForTool(run: TeamRun, parentId?: string, toolId?: string): SeatInstance | undefined {
  if (parentId) {
    const direct = run.seats.find((s) => s.id === parentId);
    if (direct) return direct;
    const via = run.seats.find((s) => (s.activity ?? []).some((a) => a.id === parentId));
    if (via) return via;
  }
  if (toolId) {
    const viaTool = run.seats.find((s) => (s.activity ?? []).some((a) => a.id === toolId));
    if (viaTool) return viaTool;
  }
  const running = run.seats.filter((s) => s.status === 'running');
  if (running.length === 1) return running[0];
  return undefined;
}

function withActivity(
  run: TeamRun,
  seatId: string,
  item: SeatActivityItem,
  summary?: string,
): TeamRun {
  const seat = run.seats.find((s) => s.id === seatId);
  if (!seat) return run;
  const prev = seat.activity ?? [];
  const nextItems = [...prev.filter((a) => a.id !== item.id), item].slice(-ACTIVITY_MAX);
  return applySeatPatch(run, seatId, {
    activity: nextItems,
    ...(summary ? { summary: clamp(summary, SUMMARY_MAX) } : {}),
  });
}

function applyToolEvent(run: TeamRun, event: unknown): TeamRun {
  if (!event || typeof event !== 'object') return run;
  const e = event as {
    type?: unknown;
    id?: unknown;
    tool?: unknown;
    input?: unknown;
    parentId?: unknown;
    source?: unknown;
    ok?: unknown;
    ts?: unknown;
  };
  if (e.type === 'tool_use' && typeof e.id === 'string' && typeof e.tool === 'string') {
    if (e.source === 'trylo-v1' && typeof e.parentId !== 'string') return run;
    if (e.tool === 'Agent' || e.tool === 'Task') {
      // Stdout sees the Agent tool_use before the file-tail spawn event.
      // Bind the queued row now so nested tools with parentId = this id
      // can attach even when the spawn event is still in flight.
      const input = e.input && typeof e.input === 'object'
        ? e.input as { subagent_type?: unknown; member_id?: unknown; prompt?: unknown }
        : undefined;
      const agentType = typeof input?.subagent_type === 'string' ? input.subagent_type : '';
      if (!isTeamSeatId(agentType)) return run;
      return applySpawn(run, {
        type: 'subagent',
        kind: 'spawn',
        id: e.id,
        agentType,
        ...(typeof input?.member_id === 'string' ? { memberId: input.member_id } : {}),
        ...(typeof input?.prompt === 'string' ? { prompt: input.prompt } : {}),
        ts: typeof e.ts === 'number' ? e.ts : Date.now(),
      }, { workspaceId: run.workspaceId, personConversationId: run.personConversationId });
    }
    const seat = findSeatForTool(run, typeof e.parentId === 'string' ? e.parentId : undefined);
    if (!seat) return run;
    const input = e.input && typeof e.input === 'object'
      ? e.input as Readonly<Record<string, unknown>>
      : undefined;
    const label = labelSeatTool(e.tool, input);
    return withActivity(run, seat.id, {
      id: e.id,
      kind: 'tool',
      round: seat.round ?? 1,
      at: typeof e.ts === 'number' ? e.ts : Date.now(),
      label,
    }, label);
  }
  if (e.type === 'tool_result' && typeof e.id === 'string') {
    if (e.source === 'trylo-v1' && typeof e.parentId !== 'string'
      && !run.seats.some(seat => seat.activity?.some(activity => activity.id === e.id))) return run;
    const seat = findSeatForTool(
      run,
      typeof e.parentId === 'string' ? e.parentId : undefined,
      e.id,
    );
    if (!seat) return run;
    const prev = (seat.activity ?? []).find((a) => a.id === e.id);
    const ok = e.ok !== false;
    const label = prev?.label ?? (typeof e.tool === 'string' ? labelSeatTool(e.tool) : '完成');
    return withActivity(run, seat.id, {
      id: e.id,
      kind: 'result',
      round: prev?.round ?? seat.round ?? 1,
      at: typeof e.ts === 'number' ? e.ts : Date.now(),
      label,
      ok,
    }, ok ? label : `${label}失败`);
  }
  return run;
}
