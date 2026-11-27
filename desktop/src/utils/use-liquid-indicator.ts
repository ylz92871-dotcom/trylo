import { useLayoutEffect, useRef, type RefObject } from 'react';
import { prefersReducedMotion } from './use-presence-transition';

export interface LiquidIndicatorOptions {
  readonly containerRef: RefObject<HTMLElement>;
  readonly indicatorRef: RefObject<HTMLElement>;
  readonly activeKey: string | number | null | undefined;
  readonly axis?: 'x' | 'y';
  /** Selector for matching the active element via `[data-liquid-key]`, or custom finder. */
  readonly itemSelector?: string;
}

function isJsdom(): boolean {
  return typeof navigator === 'undefined' || /\bjsdom\b/i.test(navigator.userAgent);
}

interface RectSpan {
  readonly pos: number;
  readonly size: number;
}

function measureTarget(target: HTMLElement, axis: 'x' | 'y'): RectSpan {
  return axis === 'x'
    ? { pos: target.offsetLeft, size: target.offsetWidth }
    : { pos: target.offsetTop, size: target.offsetHeight };
}

/**
 * Liquid Tab Indicator (SPT 10.5):
 * Measures real item geometry, stretches the leading edge before pulling the trailing edge,
 * and seamlessly interrupts/continues from the current visible state on rapid clicks.
 */
export function useLiquidIndicator(options: LiquidIndicatorOptions): void {
  const { containerRef, indicatorRef, activeKey, axis = 'x', itemSelector } = options;
  const prevSpanRef = useRef<RectSpan | null>(null);
  const animRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator || activeKey === null || activeKey === undefined) return;

    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(String(activeKey))
      : String(activeKey);
    const selector = itemSelector ?? `[data-liquid-key="${escaped}"]`;

    const applyStatic = (span: RectSpan): void => {
      if (axis === 'x') {
        indicator.style.transform = `translateX(${span.pos}px)`;
        indicator.style.width = `${span.size}px`;
      } else {
        indicator.style.transform = `translateY(${span.pos}px)`;
        indicator.style.height = `${span.size}px`;
      }
      if (span.size > 0) {
        indicator.style.opacity = '1';
        indicator.dataset.liquidReady = 'true';
      } else {
        indicator.style.opacity = '0';
        delete indicator.dataset.liquidReady;
      }
    };

    const sync = (animate: boolean): void => {
      const target = container.querySelector<HTMLElement>(selector);
      if (!target) {
        indicator.style.opacity = '0';
        delete indicator.dataset.liquidReady;
        prevSpanRef.current = null;
        return;
      }

      const next = measureTarget(target, axis);
      if (next.size <= 0) {
        indicator.style.opacity = '0';
        delete indicator.dataset.liquidReady;
        return;
      }

      const prev = prevSpanRef.current;
      prevSpanRef.current = next;

      if (!animate || !prev || prefersReducedMotion() || isJsdom() || typeof indicator.animate !== 'function') {
        animRef.current?.cancel();
        animRef.current = null;
        applyStatic(next);
        return;
      }

      // Read current visible geometry if an earlier transition is still running.
      let startPos = prev.pos;
      let startSize = prev.size;
      if (animRef.current) {
        const containerRect = container.getBoundingClientRect();
        const indRect = indicator.getBoundingClientRect();
        if (axis === 'x' && indRect.width > 0) {
          startPos = indRect.left - containerRect.left + container.scrollLeft;
          startSize = indRect.width;
        } else if (axis === 'y' && indRect.height > 0) {
          startPos = indRect.top - containerRect.top + container.scrollTop;
          startSize = indRect.height;
        }
        animRef.current.cancel();
        animRef.current = null;
      }

      if (Math.abs(startPos - next.pos) < 1 && Math.abs(startSize - next.size) < 1) {
        applyStatic(next);
        return;
      }

      const minStart = Math.min(startPos, next.pos);
      const maxEnd = Math.max(startPos + startSize, next.pos + next.size);
      const stretchedSize = Math.min(maxEnd - minStart, Math.max(startSize, next.size) * 1.45);
      const movingForward = next.pos >= startPos;
      const midPos = movingForward
        ? startPos + (next.pos - startPos) * 0.35
        : next.pos + (startPos - next.pos) * 0.25;

      const keyframes: Keyframe[] =
        axis === 'x'
          ? [
              { transform: `translateX(${startPos}px)`, width: `${startSize}px`, opacity: 1 },
              { transform: `translateX(${midPos}px)`, width: `${stretchedSize}px`, opacity: 1, offset: 0.42 },
              { transform: `translateX(${next.pos}px)`, width: `${next.size}px`, opacity: 1 },
            ]
          : [
              { transform: `translateY(${startPos}px)`, height: `${startSize}px`, opacity: 1 },
              { transform: `translateY(${midPos}px)`, height: `${stretchedSize}px`, opacity: 1, offset: 0.42 },
              { transform: `translateY(${next.pos}px)`, height: `${next.size}px`, opacity: 1 },
            ];

      const anim = indicator.animate(keyframes, {
        duration: 220,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'forwards',
      });
      animRef.current = anim;
      anim.onfinish = () => {
        if (animRef.current !== anim) return;
        animRef.current = null;
        applyStatic(next);
        anim.cancel();
      };
    };

    sync(true);

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => sync(false));
    observer?.observe(container);

    return () => {
      observer?.disconnect();
    };
  }, [containerRef, indicatorRef, activeKey, axis, itemSelector]);
}
