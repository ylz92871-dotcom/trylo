import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { SeatInstance, TeamRun } from '../team-types';
import { TeamMark } from './TeamMark';
import { currentTask, memberName, memberProgress, memberState, shortText } from './team-presentation';

/** Spatial responsibility map. The parent remains the only direction owner. */
export function TeamGraph({ run, onSelect, onPerson }: { readonly run: TeamRun; readonly onSelect: (id: string) => void; readonly onPerson?: () => void }): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const [availableWidth, setWidth] = useState(760);
  useLayoutEffect(() => {
    const update = (): void => setWidth(Math.max(600, root.current?.clientWidth ?? 760));
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    if (root.current) observer?.observe(root.current);
    return () => observer?.disconnect();
  }, []);
  const advisers = run.seats.filter(seat => ['person', 'architect', 'cad-planner'].includes(seat.seat));
  const specialists = run.seats.filter(seat => !advisers.includes(seat));
  const hasAdvisers = advisers.length > 0 && specialists.length > 0;
  const columns = hasAdvisers ? Math.max(advisers.length, specialists.length) : run.seats.length;
  const width = Math.max(availableWidth, (columns + 1) * 175);
  const place = (seats: readonly SeatInstance[], y: number): { seat: SeatInstance; x: number; y: number }[] => seats.map((seat, index) => ({
    seat, x: width * (index + 1) / (seats.length + 1), y: y + (seats.length > 2 && index !== 0 && index !== seats.length - 1 ? 24 : 0),
  }));
  const center = width / 2;
  const adviserNodes = place(advisers, 188).map(node => advisers.length === 1 && node.seat.seat === 'person' ? { ...node, x: width * .25 } : node);
  const nodes = hasAdvisers ? [...adviserNodes, ...place(specialists, 392)] : place(run.seats, 250);
  const height = Math.max(450, ...nodes.map(node => node.y + 210));
  const rail = adviserNodes.some(node => Math.abs(node.x - center) < 90) ? center + 128 : center;
  return <div className="team-constellation" ref={root} tabIndex={0} aria-label="团队分工与当前进展，可左右滚动">
    <div className="team-constellation__canvas" style={{ width, height }}>
      <svg className="team-constellation__links" width={width} height={height} aria-hidden="true">
        {nodes.map(({ seat, x, y }) => <path key={seat.id} data-state={seat.status}
          d={hasAdvisers && specialists.includes(seat)
            ? `M ${center} 152 C ${center} 170, ${rail} 160, ${rail} 180 V350 C ${rail} 374, ${x} 367, ${x} ${y}`
            : `M ${center} 152 C ${center} ${y - 30}, ${x} ${y - 55}, ${x} ${y}`} />)}
      </svg>
      <button className="team-map-origin" onClick={onPerson} style={{ left: center }} aria-label="与 Person 协调团队方向">
        <span className="team-map-origin__mark"><TeamMark role="personal" size={32} /></span><strong>Person</strong><span>统筹目标与分工</span>
      </button>
      {nodes.map(({ seat, x, y }) => <button className={`team-map-member team-map-member--${seat.status}`} key={seat.id}
        style={{ left: x, top: y }} onClick={() => onSelect(seat.id)} aria-label={`${memberName(seat)} ${memberState(seat)}`} title={currentTask(seat)}>
        <span className="team-map-member__mark"><TeamMark role={seat.seat} size={28} /><i /></span>
        <strong>{memberName(seat)}</strong><small>{memberState(seat)}</small>
        <span className="team-map-member__task">{shortText(memberProgress(seat) || currentTask(seat), 72)}</span>
      </button>)}
    </div>
  </div>;
}
