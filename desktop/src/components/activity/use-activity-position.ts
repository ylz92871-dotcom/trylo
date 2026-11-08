import { useLayoutEffect, type RefObject } from 'react';

/** Align with the shell toolbar while keeping the portal inside the viewport. */
export function useActivityPosition(panel: RefObject<HTMLDivElement>, open: boolean, anchor?: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (!open) return;
    const toolbar = anchor?.closest('.app-shell')?.querySelector('.top-bar')
      ?? document.querySelector('.app-shell .top-bar');
    const place = (): void => {
      const root = panel.current;
      if (!root) return;
      const margin = window.innerWidth < 600 ? 10 : 16;
      const preferredTop = (toolbar?.getBoundingClientRect().bottom ?? 64) + 8;
      const top = Math.max(margin, Math.min(preferredTop, window.innerHeight - 80 - margin));
      root.style.maxHeight = `${Math.max(80, Math.min(560, window.innerHeight - top - margin))}px`;
      root.style.left = `${Math.max(margin, window.innerWidth - root.offsetWidth - margin)}px`;
      root.style.top = `${top}px`;
      root.dataset.placement = 'right';
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    if (panel.current) observer?.observe(panel.current);
    if (toolbar) observer?.observe(toolbar);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [panel, open, anchor]);
}
