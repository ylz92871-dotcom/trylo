import type { TeamRun } from '../surfaces/team/team-types';
import { selectRunForConversation, teamRunsSnapshot, upsertTeamRun } from '../user-learning/team-access/profiles/team-runs-cache';
import { isTeamRunOpen } from '../domain/team-run-lifecycle';
import type { PersistableTeamRun } from '../user-learning/team-access/persist';
import { applyTeamEvents } from '../surfaces/team/team-projection';
import type { TeamOutputRecovery } from './recovered-team-output';
import { IncompleteTeamOutputError } from './recovered-team-output';
import { teamPersonFeedback } from './team-person-feedback';

export interface TeamHistoryRuntime {
  hasLocalOwner(projectKey: string, conversationId: string): boolean;
  inspectRestoredOwner(projectKey: string, conversationId: string): Promise<'owned' | 'absent' | 'detached'>;
  recoverTeamOutput?(projectKey: string, conversationId: string, teamRunId: string): Promise<TeamOutputRecovery | null>;
  hasRecoveredOwner?(projectKey: string, conversationId: string): boolean;
}

export interface RestoreTeamHistoryInput {
  readonly workspaceRoot: string;
  readonly projectKey?: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly runtime: TeamHistoryRuntime;
  readonly isCurrent?: () => boolean;
  readonly onChecking?: (run: TeamRun) => void;
  readonly onRecoveredEvents?: (recovery: TeamOutputRecovery, projected: TeamRun) => void;
  readonly now?: () => number;
}

function interruptHistory(run: PersistableTeamRun, now: number, outcome: 'interrupted' | 'cancelled' = 'interrupted'): PersistableTeamRun {
  const at = Math.max(run.updatedAt, now);
  const status = outcome === 'cancelled' ? 'cancelled' : 'failed';
  const message = outcome === 'cancelled' ? '团队执行已停止，但尾部输出不完整。已保留完成成员的记录。'
    : '上次团队执行已中断，未确认最终结果。已保留完成成员的记录。';
  return { ...run, status, lifecycle: 'closed', endedAt: at, updatedAt: at, error: message,
    seats: run.seats.map(seat => ({ ...seat, canReceiveInput: false,
      ...(['queued', 'running', 'waiting_approval'].includes(seat.status)
        ? { status, endedAt: at, error: seat.error ?? message } : {}) })) };
}

/** Reconcile a history snapshot with its execution owner; never replay work. */
export async function restoreTeamHistory(input: RestoreTeamHistoryInput): Promise<TeamRun | null> {
  const current = input.isCurrent ?? (() => true);
  const projectKey = input.projectKey ?? input.workspaceRoot;
  const selected = () => selectRunForConversation(teamRunsSnapshot(input.workspaceId), input.conversationId);
  const view = (run: ReturnType<typeof selected>): TeamRun | null => run
    ? { ...run, workspaceId: input.workspaceId, selectedSeatId: null } as TeamRun : null;
  const original = selected();
  const openHistory = teamRunsSnapshot(input.workspaceId).filter(run => run.personConversationId === input.conversationId && isTeamRunOpen(run));
  const initial = view(original);
  if (!current()) return null;
  if (!original || !initial || input.runtime.hasLocalOwner(projectKey, input.conversationId)
    || !isTeamRunOpen(original) && !input.runtime.recoverTeamOutput) return initial;
  input.onChecking?.({ ...initial, recovery: { kind: 'checking', message: '正在核对上次团队的执行状态…' } });
  let outcome: 'owned' | 'absent' | 'detached';
  try {
    // A root may have exited during reload. Read retained terminal output
    // before treating absence from the live table as interruption.
    const recovered = input.runtime.recoverTeamOutput
      ? await input.runtime.recoverTeamOutput(projectKey, input.conversationId, original.id) : null;
    if (!current()) return null;
    if (selected() !== original || input.runtime.hasLocalOwner(projectKey, input.conversationId)) return view(selected());
    if (recovered) {
      const projected = applyTeamEvents(initial, recovered.events, { workspaceId: input.workspaceId,
        personConversationId: input.conversationId, teamRunId: original.id }, teamPersonFeedback(recovered.events, original.id)) ?? initial;
      input.onRecoveredEvents?.(recovered, projected);
      await upsertTeamRun(projected, input.workspaceId);
      recovered.acknowledge();
      return current() ? view(selected()) : null;
    }
    if (!isTeamRunOpen(original)) return initial;
    outcome = await input.runtime.inspectRestoredOwner(projectKey, input.conversationId);
  } catch (error) {
    if (!current()) return null;
    const latest = selected();
    if (latest !== original || input.runtime.hasLocalOwner(projectKey, input.conversationId)) return view(latest);
    if (error instanceof IncompleteTeamOutputError && error.confirmedExited) {
      if (!isTeamRunOpen(original)) return view(original);
      const interrupted = interruptHistory(original, (input.now ?? Date.now)(), error.cancelled ? 'cancelled' : 'interrupted');
      await upsertTeamRun(interrupted, input.workspaceId, { onlyIfUnchanged: original });
      return current() ? view(selected()) : null;
    }
    return { ...initial, recovery: { kind: 'unavailable',
      message: `暂时无法核实旧团队是否退出，请重试停止。${error instanceof Error ? error.message : String(error)}` } };
  }
  if (!current()) return null;
  const latest = selected();
  if (latest !== original || outcome === 'owned' || input.runtime.hasLocalOwner(projectKey, input.conversationId)) return view(latest);
  if (outcome === 'detached') return { ...initial, recovery: { kind: 'detached',
    message: '旧团队仍在执行，输出尚未连接。请先停止旧执行，再开始新的团队任务。' } };
  const at = (input.now ?? Date.now)();
  // Retire the selected run first so equal interruption timestamps retain it
  // ahead of older records in the cache's stable terminal selection order.
  const unchanged = [original, ...openHistory.filter(run => run !== original)]
    .filter(run => teamRunsSnapshot(input.workspaceId).includes(run));
  const interrupted = unchanged.map(run => interruptHistory(run, at));
  // The cache update is synchronous before its persistence await. No stale
  // callback writes a whole old workspace array or changes another run.
  await Promise.all(interrupted.map((run, index) => upsertTeamRun(run, input.workspaceId, { onlyIfUnchanged: unchanged[index] } )));
  return current() ? view(selected()) : null;
}
