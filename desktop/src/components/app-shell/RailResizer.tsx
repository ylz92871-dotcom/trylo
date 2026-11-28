// Trylo Desktop — RailResizer.
//
// Draggable splitter with magnetic snap points (hysteresis band to prevent
// edge jitter), interruptible double-click reset, and keyboard adjustments.

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { prefersReducedMotion } from '../../utils/use-presence-transition';

export interface RailResizerProps {
  /** Which rail this resizer controls. */
  readonly side: 'left' | 'right';
  /** Current width of the rail, in px. */
  readonly width: number;
  /** Minimum width the rail may be dragged to. */
  readonly min: number;
  /** Maximum width the rail may be dragged to. */
  readonly max: number;
  /** Optional magnetic snap targets (px). */
  readonly snapPoints?: readonly number[];
  /** Width restored on double-click or Home key. */
  readonly defaultWidth?: number;
  /** Called with the new width (px) while dragging. */
  readonly onChange: (width: number) => void;
  /** Optional callback notifying the shell when pointer dragging starts/ends. */
  readonly onDraggingChange?: (dragging: boolean) => void;
}

const SNAP_ENTER_PX = 10;
const SNAP_EXIT_PX = 16;
const RESET_DURATION_MS = 200;

function isJsdom(): boolean {
  return typeof navigator === 'undefined' || /\bjsdom\b/i.test(navigator.userAgent);
}

export function RailResizer(props: RailResizerProps): ReactElement {
  const [dragging, setDragging] = useState(false);
  const [snapped, setSnapped] = useState(false);
  const start = useRef<{ x: number; w: number } | null>(null);
  const snappedPointRef = useRef<number | null>(null);
  const finish = useRef<() => void>();
  const resetAnimRef = useRef<number | null>(null);
  const latestProps = useRef(props);
  latestProps.current = props;
  const onDraggingChangeRef = useRef(props.onDraggingChange);
  onDraggingChangeRef.current = props.onDraggingChange;

  const cancelResetAnimation = (): void => {
    if (resetAnimRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(resetAnimRef.current);
      resetAnimRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      finish.current?.();
      cancelResetAnimation();
    };
  }, []);

  const clampWidth = (value: number): number =>
    Math.round(Math.max(latestProps.current.min, Math.min(latestProps.current.max, value)));

  const resolveSnappedWidth = (raw: number): number => {
    const points = latestProps.current.snapPoints;
    if (!points || points.length === 0) {
      snappedPointRef.current = null;
      setSnapped(false);
      return raw;
    }

    const active = snappedPointRef.current;
    if (active !== null) {
      if (Math.abs(raw - active) <= SNAP_EXIT_PX) {
        setSnapped(true);
        return clampWidth(active);
      }
      snappedPointRef.current = null;
    }

    let bestPoint: number | null = null;
    let bestDist = Infinity;
    for (const point of points) {
      if (point < latestProps.current.min || point > latestProps.current.max) continue;
      const dist = Math.abs(raw - point);
      if (dist <= SNAP_ENTER_PX && dist < bestDist) {
        bestPoint = point;
        bestDist = dist;
      }
    }

    if (bestPoint !== null) {
      snappedPointRef.current = bestPoint;
      setSnapped(true);
      return clampWidth(bestPoint);
    }

    setSnapped(false);
    return raw;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    cancelResetAnimation();
    finish.current?.();
    start.current = { x: e.clientX, w: props.width };
    snappedPointRef.current = null;
    setSnapped(false);
    setDragging(true);
    onDraggingChangeRef.current?.(true);

    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    handle.setPointerCapture?.(pointerId);

    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      const s = start.current;
      if (!s) return;
      const dx = ev.clientX - s.x;
      const raw = clampWidth(latestProps.current.side === 'left' ? s.w + dx : s.w - dx);
      latestProps.current.onChange(resolveSnappedWidth(raw));
    };

    const onUp = (ev?: PointerEvent): void => {
      if (ev && ev.pointerId !== pointerId) return;
      start.current = null;
      snappedPointRef.current = null;
      setDragging(false);
      setSnapped(false);
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

  const onDoubleClick = (): void => {
    if (props.defaultWidth === undefined) return;
    const target = clampWidth(props.defaultWidth);
    const from = props.width;
    if (from === target) return;

    cancelResetAnimation();
    if (prefersReducedMotion() || isJsdom() || typeof requestAnimationFrame !== 'function') {
      props.onChange(target);
      return;
    }

    const startTime = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - startTime) / RESET_DURATION_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      latestProps.current.onChange(Math.round(from + (target - from) * eased));
      if (t < 1) {
        resetAnimRef.current = requestAnimationFrame(tick);
      } else {
        resetAnimRef.current = null;
      }
    };
    resetAnimRef.current = requestAnimationFrame(tick);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16;
    const dir = props.side === 'left' ? 1 : -1;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      cancelResetAnimation();
      props.onChange(clampWidth(props.width + step * dir));
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      cancelResetAnimation();
      props.onChange(clampWidth(props.width - step * dir));
    } else if (event.key === 'Home') {
      event.preventDefault();
      cancelResetAnimation();
      props.onChange(clampWidth(props.defaultWidth ?? props.min));
    } else if (event.key === 'End') {
      event.preventDefault();
      cancelResetAnimation();
      props.onChange(clampWidth(props.max));
    }
  };

  return (
    <div
      className={`rail-resizer rail-resizer--${props.side}${dragging ? ' rail-resizer--dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuenow={props.width}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-label={props.side === 'left' ? 'Resize sidebar' : 'Resize file panel'}
      title={props.defaultWidth !== undefined ? '拖动调整宽度，双击恢复默认' : undefined}
      data-snapped={snapped ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  );
}
