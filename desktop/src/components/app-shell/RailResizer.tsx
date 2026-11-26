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

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';

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
  /** Optional callback notifying the shell when pointer dragging starts/ends. */
  readonly onDraggingChange?: (dragging: boolean) => void;
}

export function RailResizer(props: RailResizerProps): ReactElement {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; w: number } | null>(null);
  const finish = useRef<() => void>();
  const onDraggingChangeRef = useRef(props.onDraggingChange);
  onDraggingChangeRef.current = props.onDraggingChange;
  useEffect(() => () => finish.current?.(), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    finish.current?.();
    start.current = { x: e.clientX, w: props.width };
    setDragging(true);
    onDraggingChangeRef.current?.(true);
    const handle = e.currentTarget, pointerId = e.pointerId;
    const previousCursor = document.body.style.cursor, previousSelection = document.body.style.userSelect;
    // Keep dragging when the pointer crosses a browser/iframe surface.
    handle.setPointerCapture?.(pointerId);

    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      const s = start.current;
      if (!s) return;
      const dx = ev.clientX - s.x;
      // Left rail grows to the right; right rail shrinks to the right.
      const next = props.side === 'left' ? s.w + dx : s.w - dx;
      props.onChange(Math.round(Math.max(props.min, Math.min(props.max, next))));
    };
    const onUp = (ev?: PointerEvent): void => {
      if (ev && ev.pointerId !== pointerId) return;
      start.current = null;
      setDragging(false);
      onDraggingChangeRef.current?.(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      handle.removeEventListener('lostpointercapture', onUp);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelection;
      finish.current = undefined;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    handle.addEventListener('lostpointercapture', onUp);
    finish.current = onUp;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div
      className={`rail-resizer rail-resizer--${props.side}${dragging ? ' rail-resizer--dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.side === 'left' ? 'Resize sidebar' : 'Resize file panel'}
      onPointerDown={onPointerDown}
    />
  );
}
