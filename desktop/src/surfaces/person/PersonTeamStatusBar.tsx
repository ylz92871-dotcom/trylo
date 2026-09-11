import type { ReactElement } from 'react';
import { SEAT_STATUS_LABEL } from '../shared/status';
import { TEAM_ROLE_DISPLAY_NAME } from '../team/team-profile-types';
import { clampText } from '../shared/format';
import type { TeamRun, TryloTeamSeatId } from '../team/team-types';

export interface PersonTeamStatusBarProps {
  /** The TeamRun attached to the current Person conversation. */
  readonly run: TeamRun | null;
  readonly onOpenTeam: () => void;
}

/**
 * One line above the InputBar (Foundation spec §10.7). Renders ONLY for
 * a non-terminal run with on-stage seats — never as a 组队 nag. No
 * Users icon, no pill, no brand-glow: plain text + a 查看 affordance.
 */
export function PersonTeamStatusBar(props: PersonTeamStatusBarProps): ReactElement | null {
  const { run } = props;
  if (!run) return null;
  if (run.status !== 'running' && run.status !== 'waiting') return null;
  if (run.seats.length === 0) return null;

  const live = run.seats.filter((s) => s.status === 'running' || s.status === 'waiting_approval');
  const activeSeat = live.find((s) => s.seat !== 'person') ?? live[0];
  const memberName = (seat: { displayName?: string; seat: TryloTeamSeatId }): string =>
    seat.displayName ?? TEAM_ROLE_DISPLAY_NAME[seat.seat];

  return (
    <div className="person-team-status-bar" role="region" aria-label="团队状态">
      <span className="person-team-status-bar__text">
        团队进行中
        {activeSeat
          ? ` · ${memberName(activeSeat)} ${SEAT_STATUS_LABEL[activeSeat.status]} · ${clampText(activeSeat.summary, 24)}`
          : ' · 等待开始'}
      </span>
      <button
        type="button"
        className="person-team-status-bar__action"
        onClick={props.onOpenTeam}
      >
        查看
      </button>
    </div>
  );
}

export function PersonTeamComposeHint(props: {
  readonly onCompose: () => void;
}): ReactElement {
  return (
    <div className="person-team-status-bar" role="region" aria-label="用团队做">
      <span className="person-team-status-bar__text">用团队做这件事</span>
      <button
        type="button"
        className="person-team-status-bar__action"
        onClick={props.onCompose}
      >
        组一组
      </button>
    </div>
  );
}
