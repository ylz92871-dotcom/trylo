import { useLayoutEffect, useState, type RefObject } from 'react';
import type { ShelfEntry } from './entries';

/** The nonvirtual team feed retains all question nodes; its existing owner still scrolls. */
export function useNativeQuestionReading(
  entries: readonly ShelfEntry[],
  viewport: RefObject<HTMLElement>,
): string | null {
  const [reading, setReading] = useState<string | null>(null);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    let frame: number | null = null;
    const measure = (): void => {
      frame = null;
      const top = node.getBoundingClientRect().top + 4;
      let current = entries[0]?.id ?? null;
      for (const row of node.querySelectorAll<HTMLElement>('[data-conversation-question]')) {
        if (row.getBoundingClientRect().top > top) break;
        current = row.dataset.conversationQuestion ?? current;
      }
      setReading(current);
    };
    const schedule = (): void => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    node.addEventListener('scroll', schedule, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(node);
    schedule();
    return () => {
      node.removeEventListener('scroll', schedule);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [entries, viewport]);
  return entries.some((entry) => entry.id === reading) ? reading : (entries.at(-1)?.id ?? null);
}
