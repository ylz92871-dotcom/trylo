/**
 * Status labels + CSS token names for the team surface.
 *
 * The four states the bottom strip and the summary card actually render
 * are: running, queued, completed, failed. waiting_approval and
 * cancelled are kept in the type system (so live events will not have
 * to widen the type later) but the visual treatment maps onto the
 * running or failed buckets for the P0 fixture / first live run.
 */
import type { SeatRunStatus, TeamRunStatus } from '../team/team-types';

export const SEAT_STATUS_LABEL: Record<SeatRunStatus, string> = {
  queued: '排队',
  running: '运行中',
  waiting_approval: '待审批',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const TEAM_STATUS_LABEL: Record<TeamRunStatus, string> = {
  running: '进行中',
  waiting: '等待中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/**
 * The CSS class suffix used on chips / cards to color the status dot
 * and the seat-identity bar. Components do `seat--${seatStatusClass(s)}`
 * and the CSS does the rest — keeps Tailwind-style token names out of
 * the component code.
 */
export function seatStatusClass(status: SeatRunStatus): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'waiting_approval':
      return 'waiting-approval';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'queued':
    default:
      return 'queued';
  }
}

export function isTerminalSeatStatus(status: SeatRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
