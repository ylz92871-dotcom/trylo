import type { ReactElement } from 'react';
import { TEAM_STATUS_LABEL } from '../../shared/status';
import { TEAM_ROLE_DISPLAY_NAME } from '../team-profile-types';
import { SeatDetail } from '../SeatDetail';
import { MemberRow } from './MemberRow';
import type { SeatInstance, TeamRun } from '../team-types';

export interface TeamRunViewProps {
  readonly run: TeamRun;
  readonly onStopRun?: () => void;
  readonly onNewTeam?: () => void;
  readonly onSelectSeat: (seatId: string | null) => void;
  readonly onCancelSeat?: (seatId: string) => void;
  readonly onOpenPerson?: () => void;
}

const ACTIVE_SEAT = new Set(['running', 'waiting_approval']);

function memberName(seat: SeatInstance): string {
  return seat.displayName ?? TEAM_ROLE_DISPLAY_NAME[seat.seat];
}

/**
 * The quiet run surface (Foundation spec §10.5): one goal line, then
 * one row per member; clicking a row expands that member inline. No
 * bottom strip, no summary grid, no identity colors.
 */
export function TeamRunView(props: TeamRunViewProps): ReactElement {
  const { run } = props;
  const hasActive = run.seats.some((s) => ACTIVE_SEAT.has(s.status));
  const terminal =
    run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';

  return (
    <div className="team-run">
      <header className="team-run__head">
        <div className="team-run__head-text">
          <h2 className="team-run__title">{run.summary.oneLiner || run.summary.title}</h2>
          <p className="team-run__meta">
            <span className={`team-run__state team-run__state--${run.status}`}>
              {TEAM_STATUS_LABEL[run.status]}
            </span>
            <span className="team-run__roster">
              {run.seats.map(memberName).join(' · ')}
            </span>
          </p>
        </div>
        <div className="team-run__head-actions">
          {terminal && props.onNewTeam ? (
            <button type="button" className="team-run__ghost" onClick={props.onNewTeam}>
              新团队
            </button>
          ) : null}
          {hasActive && props.onStopRun ? (
            <button type="button" className="team-run__ghost" onClick={props.onStopRun}>
              停止
            </button>
          ) : null}
        </div>
      </header>
      <div className="team-run__members">
        {run.seats.map((seat) => (
          <div key={seat.id} className="team-run__member-block">
            <MemberRow
              seat={seat}
              expanded={run.selectedSeatId === seat.id}
              onToggle={(seatId) =>
                props.onSelectSeat(run.selectedSeatId === seatId ? null : seatId)}
            />
            {run.selectedSeatId === seat.id ? (
              <SeatDetail
                seat={seat}
                onBack={() => props.onSelectSeat(null)}
                {...(props.onCancelSeat ? { onCancel: props.onCancelSeat } : {})}
                {...(props.onOpenPerson ? { onOpenPerson: props.onOpenPerson } : {})}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
