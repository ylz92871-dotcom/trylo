import type { TeamProgressReport } from '../../domain/team-progress';
import type { SeatInstance, TeamRun } from './team-types';

export function assignmentText(prompt: string): string {
  const boundary = prompt.lastIndexOf('\nTask:\n');
  if (boundary >= 0) return prompt.slice(boundary + 7).trim();
  const chineseTask = /(?:^|[。\n])\s*任务[：:]\s*/.exec(prompt);
  return (chineseTask && /^你是/.test(prompt.trim()) ? prompt.slice(chineseTask.index + chineseTask[0].length) : prompt).trim();
}

/** Older histories remain readable; unknown round times remain unknown. */
export function reportHistory(run: TeamRun): readonly TeamProgressReport[] {
  if (run.reports !== undefined) return run.reports;
  return run.seats.flatMap(seat => {
    const rounds = seat.conversation?.length ? seat.conversation : [{ round: seat.round ?? 1, prompt: seat.prompt, result: seat.result }];
    const reports = rounds.flatMap(round => {
      const common = { seatId: seat.id, memberId: seat.memberId, round: round.round };
      const rows: TeamProgressReport[] = [];
      if (round.round === 1 && round.prompt?.trim()) rows.push({ ...common, id: `assignment:${seat.id}:${round.round}`, kind: 'assignment',
        at: round.round === 1 ? seat.startedAt : undefined, text: assignmentText(round.prompt) });
      if (round.result?.trim()) rows.push({ ...common, id: `report:${seat.id}:${round.round}`, kind: 'report',
        at: round.round === seat.round ? seat.endedAt : undefined, text: round.result, streaming: false });
      return rows;
    });
    if (seat.status === 'failed' && seat.error) reports.push({ seatId: seat.id, memberId: seat.memberId, round: seat.round,
      id: `error:${seat.id}:${seat.round ?? 1}`, kind: 'error', text: seat.error, at: seat.endedAt, streaming: false });
    return reports;
  });
}

function appendReport(run: TeamRun, report: TeamProgressReport): TeamRun {
  const reports = [...reportHistory(run)];
  const index = reports.findIndex(item => item.id === report.id);
  if (index < 0) reports.push(report);
  else {
    const previous = reports[index]!;
    if (previous.text === report.text && previous.streaming === report.streaming) return run;
    if (previous.streaming || previous.text === report.text) reports[index] = { ...report, at: previous.at ?? report.at };
    else {
      if (reports.some(item => item.id.startsWith(`${report.id}:revision:`) && item.text === report.text)) return run;
      reports.push({ ...report, id: `${report.id}:revision:${reports.length}` });
    }
  }
  return { ...run, reports };
}

export function recordMemberProgress(before: TeamRun, after: TeamRun, event: unknown): TeamRun {
  if (before === after || !event || typeof event !== 'object') return after;
  const e = event as Record<string, unknown>;
  if (e.type !== 'subagent' || typeof e.id !== 'string') return after;
  const seat = after.seats.find(value => value.id === e.id);
  if (!seat) return after;
  let next = after.reports === undefined ? { ...after, reports: reportHistory(before) } : after;
  const round = seat.round ?? 1;
  const common = { seatId: seat.id, memberId: seat.memberId, round,
    at: typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : Date.now() };
  const observation = (event as import('./team-projection').TeamSubagentEvent).observation;
  if (observation?.kind === 'report' && observation.text && observation.reportState) next = appendReport(next, { ...common,
    id: `progress:${seat.memberId ?? seat.id}:${observation.round}:${observation.id}`, kind: observation.reportState, text: observation.text });
  const previousSeat = before.seats.find(previous => previous.id === seat.id)
    ?? (seat.memberId ? before.seats.find(previous => previous.memberId === seat.memberId) : undefined)
    ?? (before.seats.filter(previous => previous.seat === seat.seat).length === 1
      ? before.seats.find(previous => previous.seat === seat.seat) : undefined);
  const firstAssignment = e.kind === 'spawn' && previousSeat?.status === 'queued';
  if (firstAssignment && typeof e.prompt === 'string' && e.prompt.trim()) next = appendReport(next, { ...common,
    id: `assignment:${seat.id}:${round}`, kind: 'assignment', text: assignmentText(e.prompt) });
  if (typeof e.result === 'string' && e.result.trim()) next = appendReport(next, { ...common,
    id: `report:${seat.id}:${round}`, kind: 'report', text: e.result,
    streaming: e.kind === 'update' && seat.status === 'running' && seat.awaitingInput !== true });
  if (seat.status === 'failed' && seat.error) next = appendReport(next, { ...common,
    id: `error:${seat.id}:${round}`, kind: 'error', text: seat.error, streaming: false });
  return next;
}

function seatForTarget(run: TeamRun, target: unknown): SeatInstance | undefined {
  return typeof target === 'string' ? run.seats.find(seat => seat.id === target || seat.taskId === target) : undefined;
}

function delivery(output: unknown): 'queued' | 'continued' | 'restarted' | 'sent' {
  let value: unknown = output;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof value === 'string') { try { value = JSON.parse(value) as unknown; } catch { return 'sent'; } }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'sent';
    const row = value as Record<string, unknown>;
    if (row.delivery === 'queued' || row.delivery === 'replaced_queued') return 'queued';
    if (row.delivery === 'continued' || row.delivery === 'restarted') return row.delivery;
    value = row.value ?? row.result ?? row.data ?? row.output;
  }
  return 'sent';
}

/** A real send_input exchange, not an inferred handoff from member prose. */
export function recordTeamHandoff(run: TeamRun, event: unknown): TeamRun {
  if (!event || typeof event !== 'object') return run;
  const e = event as Record<string, unknown>;
  if (typeof e.id !== 'string') return run;
  const at = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : Date.now();
  if (e.type === 'tool_use' && e.tool === 'send_input' && e.input && typeof e.input === 'object') {
    const input = e.input as Record<string, unknown>;
    const target = seatForTarget(run, input.target);
    if (!target || typeof input.message !== 'string' || run.handoffs?.some(item => item.id === e.id)) return run;
    const from = typeof e.parentId === 'string' ? run.seats.find(seat => seat.id === e.parentId) : undefined;
    return { ...run, handoffs: [...(run.handoffs ?? []), { id: e.id, fromSeatId: from?.id ?? (typeof e.parentId === 'string' ? e.parentId : undefined), fromMemberId: from?.memberId,
      toSeatId: target.id, toMemberId: target.memberId, message: input.message, at, status: 'sending' }] };
  }
  if (e.type !== 'tool_result' || !run.handoffs?.some(item => item.id === e.id && item.status === 'sending')) return run;
  return { ...run, handoffs: run.handoffs.map(item => item.id !== e.id ? item : { ...item, settledAt: at,
    status: e.ok === false ? 'failed' : delivery(e.output),
    ...(e.ok === false ? { error: typeof e.output === 'string' ? e.output : '发送失败，未获得投递确认。' } : {}) }) };
}
