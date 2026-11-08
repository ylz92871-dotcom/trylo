import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { NativeBrowserBounds } from '../../host-adapter/native-browser';

interface Options {
  readonly element: RefObject<HTMLElement>;
  readonly scope?: string;
  readonly tab?: string;
  readonly visible: boolean;
  readonly setBounds?: (bounds: NativeBrowserBounds, visible: boolean) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

/** Measure committed geometry before paint; external layout events share one frame. */
export function useNativeBrowserBounds(options: Options): void {
  const latest = useRef(options);
  latest.current = options;
  const report = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const box = options.element.current,
      send = options.setBounds;
    if (!box || !send || !options.scope) return;
    let disposed = false,
      frame: number | null = null,
      last = '';
    const measure = (): void => {
      const rect = box.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const show = latest.current.visible;
      const key = JSON.stringify([rect.left, rect.top, rect.width, rect.height, show]);
      if (key === last) return;
      last = key;
      void send({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, show).catch(
        (error) => {
          if (!disposed) {
            last = '';
            latest.current.onError(error);
          }
        },
      );
    };
    const schedule = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    report.current = measure;
    const resize = new ResizeObserver(schedule);
    resize.observe(box);
    const movement = new MutationObserver(schedule);
    for (let parent = box.parentElement; parent; parent = parent.parentElement)
      movement.observe(parent, { attributes: true, attributeFilter: ['style', 'class'] });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      disposed = true;
      report.current = () => {};
      resize.disconnect();
      movement.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [options.element, options.setBounds, options.scope, options.tab]);

  // A React-driven splitter already committed its new width. Do not wait for
  // ResizeObserver plus another animation frame before moving a native child.
  useLayoutEffect(() => {
    report.current();
  });
}
