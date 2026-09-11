/**
 * Project CLI `subagent` lifecycle events for the five Team seats
 * into a TeamRun. Person chat must not render these — applyEvents
 * skips the same ids; this module is the only consumer.
 *
 * P0: prompt / result / status. Per-seat tool timelines stay later.
 */
import { isTeamSeatId } from '../shared/seats';
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
  readonly workspaceId: string;
  readonly personConversationId: string;
}

export interface TeamSubagentEvent {
  readonly type: 'subagent';
  readonly kind: 'spawn' | 'end';
  readonly id: string;
  readonly agentType?: string;
  /** Member instance uuid forwarded from the AgentTool `member_id` field
   *  (Foundation spec §8.2). Spawn events only; end events match on id. */
  readonly memberId?: string;
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

function isTeamSubagentEvent(event: unknown): event is TeamSubagentEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as { type?: unknown; kind?: unknown; id?: unknown; agentType?: unknown };
  if (e.type !== 'subagent') return false;
  if (e.kind !== 'spawn' && e.kind !== 'end') return false;
  if (typeof e.id !== 'string' || e.id.length === 0) return false;
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
  };
  if (run.seats.some(s => s.id === event.id)) {
    return withDerivedStatus(applySeatPatch(run, event.id, patch));
  }
  // Foundation spec §7.6.3 — bind the spawn onto a QUEUED row from the
  // frozen profile when one exists:
  //   1. exact memberId hit, 2. FIFO unused queued row of this baseRole.
  // End events only carry the tool_use id, so binding here is what makes
  // them resolvable (and keeps two workers from swapping overlays).
  const queued = run.seats.find(
    (s) => s.status === 'queued' &&
      (event.memberId !== undefined
        ? s.memberId === event.memberId
        : false),
  )
    ?? run.seats.find(
      (s) => s.status === 'queued' && s.seat === event.agentType,
    );
  if (queued) {
    return withDerivedStatus(applySeatPatch(run, queued.id, {
      ...patch,
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
  if (existing.status === 'cancelled') {
    return withDerivedStatus(
      applySeatPatch(run, event.id, {
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
        status: 'waiting_approval' as const,
        summary: clamp(`Person 否决 · ${reason}`.trim(), SUMMARY_MAX),
        ...(result !== undefined ? { result } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.ts !== undefined ? { endedAt: event.ts } : {}),
      }),
    );
  }
  const status: SeatRunStatus = 'completed';
  const summary = result ? clamp(result, SUMMARY_MAX) : existing.summary;
  return withDerivedStatus(
    applySeatPatch(run, event.id, {
      status,
      summary,
      ...(result !== undefined ? { result } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.ts !== undefined ? { endedAt: event.ts } : {}),
    }),
  );
}

/** Optimistic local cancel. The CLI `stop_task` follows from App. */
export function cancelTeamSeat(run: TeamRun, seatId: string, at = Date.now()): TeamRun {
  const existing = run.seats.find(s => s.id === seatId);
  if (!existing) return run;
  if (existing.status !== 'running' && existing.status !== 'waiting_approval') {
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
    if (!next || next.personConversationId !== ctx.personConversationId) {
      continue;
    }
    if (next.status === 'completed' || next.status === 'failed' || next.status === 'cancelled') {
      continue;
    }
    if (isTeamSubagentEvent(event)) {
      next = event.kind === 'spawn'
        ? applySpawn(next, event, ctx, extras)
        : applyEnd(next, event, extras);
      touched = true;
      continue;
    }
    const withTool = applyToolEvent(next, event);
    if (withTool !== next) {
      next = withTool;
      touched = true;
    }
  }
  return touched ? next : run;
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
    case 'Read': return file ? `读 ${file}` : '读文件';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': return file ? `改 ${file}` : '改文件';
    case 'Bash':
    case 'PowerShell': return '命令';
    case 'Grep':
    case 'Glob': return '搜索';
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
    ok?: unknown;
    ts?: unknown;
  };
  if (e.type === 'tool_use' && typeof e.id === 'string' && typeof e.tool === 'string') {
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
      at: typeof e.ts === 'number' ? e.ts : Date.now(),
      label,
    }, label);
  }
  if (e.type === 'tool_result' && typeof e.id === 'string') {
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
      at: typeof e.ts === 'number' ? e.ts : Date.now(),
      label,
      ok,
    }, ok ? label : `${label}失败`);
  }
  return run;
}
