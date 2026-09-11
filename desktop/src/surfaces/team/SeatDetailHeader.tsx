import type { ReactElement } from 'react';
import { useCallback, useMemo } from 'react';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { seatDescriptor } from '../shared/seats';
import { SEAT_STATUS_LABEL, seatStatusClass } from '../shared/status';
import { formatDuration } from '../shared/format';
import type { SeatInstance } from './team-types';

export interface SeatDetailHeaderProps {
  readonly seat: SeatInstance;
  readonly onBack: () => void;
  readonly onCancel?: (seatId: string) => void;
}

/**
 * Quiet header for a member's inline detail (Foundation spec §10.5).
 * The accent bar, short-letter block, and role-name identity chrome are
 * gone — the row shows the frozen displayName, the status word, the
 * 「独立」 hint for Reviewer/Verifier, and cancel for active members.
 */
export function SeatDetailHeader(props: SeatDetailHeaderProps): ReactElement {
  const { seat } = props;
  const independent = seatDescriptor(seat.seat).independence !== 'none';
  const isRunning = seat.status === 'running' || seat.status === 'waiting_approval';
  const dur = useMemo(
    () => formatDuration(seat.durationMs ?? (seat.endedAt && seat.startedAt ? seat.endedAt - seat.startedAt : undefined)),
    [seat.durationMs, seat.endedAt, seat.startedAt],
  );
  const handleCancel = useCallback(() => {
    props.onCancel?.(seat.id);
  }, [props, seat.id]);

  return (
    <div className={`seat-detail__header seat-detail__header--${seatStatusClass(seat.status)}`}>
      <button
        type="button"
        className="seat-detail__back"
        onClick={props.onBack}
        aria-label="收起成员详情"
      >
        <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
        <span>收起</span>
      </button>
      <div className="seat-detail__heading">
        <div className="seat-detail__title-row">
          <h2 className="seat-detail__name">{seat.displayName ?? seatDescriptor(seat.seat).displayName}</h2>
          {independent && (
            <span className="seat-detail__independent" title="该席位不能被指令 pass">
              <ShieldCheck size={12} strokeWidth={2.2} aria-hidden="true" />
              <span>独立</span>
            </span>
          )}
          <span className={`seat-detail__status seat-detail__status--${seatStatusClass(seat.status)}`}>
            {SEAT_STATUS_LABEL[seat.status]}
          </span>
        </div>
      </div>
      <div className="seat-detail__meta">
        <div className="seat-detail__metric">
          <span className="seat-detail__metric-label">耗时</span>
          <span className="seat-detail__metric-value">{dur}</span>
        </div>
        {props.onCancel ? (
          <button
            type="button"
            className="seat-detail__cancel"
            onClick={handleCancel}
            disabled={!isRunning}
            title={isRunning ? '取消该成员' : '该成员不在运行中'}
          >
            取消
          </button>
        ) : null}
      </div>
    </div>
  );
}
