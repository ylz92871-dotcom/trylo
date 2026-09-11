import type { ReactElement } from 'react';
import { SEAT_STATUS_LABEL, seatStatusClass } from '../../shared/status';
import { TEAM_ROLE_DISPLAY_NAME } from '../team-profile-types';
import type { SeatInstance } from '../team-types';

export interface MemberRowProps {
  readonly seat: SeatInstance;
  readonly expanded: boolean;
  readonly onToggle: (seatId: string) => void;
}

function memberName(seat: SeatInstance): string {
  return seat.displayName ?? TEAM_ROLE_DISPLAY_NAME[seat.seat] ?? seat.seat;
}

/**
 * One member, one line (Foundation spec §10.5): displayName + status
 * word + clamped summary. No avatar, no accent bar, no letter block.
 * Clicking expands THIS member's detail inline; only one is open.
 */
export function MemberRow(props: MemberRowProps): ReactElement {
  const { seat, expanded } = props;
  const clickable = seat.status !== 'queued';
  return (
    <button
      type="button"
      className={`team-run__member team-run__member--${seatStatusClass(seat.status)}${expanded ? ' team-run__member--expanded' : ''}`}
      onClick={() => props.onToggle(seat.id)}
      aria-expanded={expanded}
      aria-label={`${memberName(seat)} ${SEAT_STATUS_LABEL[seat.status]}`}
      disabled={!clickable}
    >
      <span className="team-run__member-name">{memberName(seat)}</span>
      <span className={`team-run__member-status team-run__member-status--${seatStatusClass(seat.status)}`}>
        {SEAT_STATUS_LABEL[seat.status]}
      </span>
      <span className="team-run__member-summary">{seat.summary}</span>
    </button>
  );
}
