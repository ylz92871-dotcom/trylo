// Trylo Desktop — RailResizer.
//
// A thin, draggable splitter used to resize the left and right
// rails by dragging. This is the standard "drag the divider to
// resize the panel" pattern (e.g. react-resizable-panels /
// allotment). Implemented with Pointer Events so it works for
// mouse and touch without a dependency.
//
// For the left rail the handle sits on its right edge and
// dragging right makes it wider; for the right rail the handle
// sits on its left edge and dragging right makes it narrower.

import { useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';

export interface RailResizerProps {
  /** Which rail this resizer controls. */
  readonly side: 'left' | 'right';
  /** Current width of the rail, in px. */
  readonly width: number;
  /** Minimum width the rail may be dragged to. */
  readonly min: number;
  /** Maximum width the rail may be dragged to. */
  readonly max: number;
  /** Called with the new width (px) while dragging. */
  readonly onChange: (width: number) => void;
}

export function RailResizer(props: RailResizerProps): ReactElement {
  const start = useRef<{ x: number; w: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    start.current = { x: e.clientX, w: props.width };

    const onMove = (ev: PointerEvent): void => {
      const s = start.current;
      if (!s) return;
      const dx = ev.clientX - s.x;
      // Left rail grows to the right; right rail shrinks to the right.
      const next = props.side === 'left' ? s.w + dx : s.w - dx;
      props.onChange(Math.round(Math.max(props.min, Math.min(props.max, next))));
    };
    const onUp = (): void => {
      start.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div
      className={`rail-resizer rail-resizer--${props.side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.side === 'left' ? 'Resize sidebar' : 'Resize file panel'}
      onPointerDown={onPointerDown}
    />
  );
}
