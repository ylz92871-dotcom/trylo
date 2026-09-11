import type { ReactElement } from 'react';
import { SEAT_STATUS_LABEL } from '../shared/status';
import { TEAM_ROLE_DISPLAY_NAME, TEAM_ROLE_DUTY } from './team-profile-types';
import type { SeatActivityItem, SeatInstance } from './team-types';

export interface SeatDetailProps {
  readonly seat: SeatInstance;
  readonly onBack: () => void;
  readonly onCancel?: (seatId: string) => void;
  readonly onOpenPerson?: () => void;
}

export function SeatDetail(props: SeatDetailProps): ReactElement {
  const { seat } = props;
  const name = seat.displayName ?? TEAM_ROLE_DISPLAY_NAME[seat.seat];
  const activity = seat.activity ?? [];
  const independent = seat.seat === 'reviewer' || seat.seat === 'verifier';
  const canCancel = seat.status === 'running' || seat.status === 'waiting_approval';

  return (
    <div className="seat-detail">
      <div className="seat-detail__meta-line">
        <span>{name}</span>
        <span>{SEAT_STATUS_LABEL[seat.status]}</span>
        {independent ? <span>独立</span> : null}
      </div>
      <p className="seat-detail__duty">{TEAM_ROLE_DUTY[seat.seat]}</p>

      {activity.length > 0 ? (
        <ol className="seat-detail__activity">
          {activity.slice(-12).map((item) => (
            <li key={item.id} className={activityClass(item)}>
              {item.label}
            </li>
          ))}
        </ol>
      ) : (
        <p className="seat-detail__empty">
          {seat.status === 'queued' ? '还没轮到。' : '还没有动作。'}
        </p>
      )}

      {seat.status === 'completed' && seat.result ? (
        <p className="seat-detail__result">{seat.result}</p>
      ) : null}
      {seat.status === 'failed' ? (
        <p className="seat-detail__result seat-detail__result--failed">{seat.error ?? '失败。'}</p>
      ) : null}

      {seat.status === 'waiting_approval' && props.onOpenPerson ? (
        <button type="button" className="seat-detail__link" onClick={props.onOpenPerson}>
          去对话里批准
        </button>
      ) : null}

      <div className="seat-detail__actions">
        <button type="button" className="seat-detail__link" onClick={props.onBack}>
          收起
        </button>
        {props.onCancel && canCancel ? (
          <button type="button" className="seat-detail__link" onClick={() => props.onCancel?.(seat.id)}>
            取消
          </button>
        ) : null}
      </div>
    </div>
  );
}

function activityClass(item: SeatActivityItem): string {
  if (item.kind === 'result' && item.ok === false) return 'seat-detail__activity-item seat-detail__activity-item--fail';
  return 'seat-detail__activity-item';
}
