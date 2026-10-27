import { TEAM_ROLE_DISPLAY_NAME } from '../team-profile-types';
import { SEAT_STATUS_LABEL } from '../../shared/status';
import type { SeatInstance, TeamRun } from '../team-types';
import type { TeamHandoffRecord } from '../../../domain/team-progress';
import { assignmentText } from '../team-progress-projection';

export const memberName = (seat: SeatInstance): string => seat.displayName ?? TEAM_ROLE_DISPLAY_NAME[seat.seat];
export function memberProgress(seat: SeatInstance): string {
  const report = seat.observations?.filter(item => item.kind === 'report').at(-1);
  if (report?.text) return report.text;
  if (seat.error) return seat.error;
  if (/^你是|^#{1,3}\s|^(?:Intent|Veto|User questions)/i.test(seat.summary.trim())) return memberState(seat);
  return seat.summary;
}
export const currentTask = (seat: SeatInstance): string => {
  const prompt = seat.conversation?.find(round => round.round === seat.round)?.prompt ?? seat.prompt;
  return prompt ? assignmentText(prompt).replace(/\s+/g, ' ').trim() : '尚未提供任务说明';
};
export const shortText = (text: string, max = 100): string => text.length > max ? `${text.slice(0, max - 1)}…` : text;
export const memberState = (seat: SeatInstance): string => seat.parked && seat.canReceiveInput ? '待分派'
  : seat.status === 'running' && seat.awaitingInput === true ? '等待后续'
    : SEAT_STATUS_LABEL[seat.status];
export const timeLabel = (at: number | undefined): string => at === undefined ? ''
  : new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
export const findMember = (run: TeamRun, seatId: string, memberId?: string): SeatInstance | undefined =>
  run.seats.find(seat => seat.id === seatId) ?? (memberId ? run.seats.find(seat => seat.memberId === memberId) : undefined);
export const handoffState = (handoff: TeamHandoffRecord): string => ({ sending: '发送中', sent: '已发送', queued: '已入队',
  continued: '已续接', restarted: '已重启', failed: '投递失败' })[handoff.status];

export function handoffSender(run: TeamRun, handoff: TeamHandoffRecord): string {
  if (!handoff.fromSeatId) return 'Person';
  const from = findMember(run, handoff.fromSeatId, handoff.fromMemberId);
  return from ? memberName(from) : run.frozenProfile.members.find(member => member.memberId === handoff.fromMemberId)?.displayName ?? '历史成员';
}
