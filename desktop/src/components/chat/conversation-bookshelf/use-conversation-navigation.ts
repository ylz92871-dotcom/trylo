import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import type { ListItem } from '../MessageList';
import type { ChatMessage } from '../types';
import { conversationEntries, entryAtRow, type IndexedShelfEntry } from './entries';

interface NavigationOptions {
  readonly messages: readonly ChatMessage[];
  readonly items: readonly ListItem[];
  readonly scrollerRef: RefObject<HTMLElement>;
  readonly virtuosoRef: RefObject<VirtuosoHandle>;
  readonly pauseFollow: () => void;
}

/** Reading position is a projection of the real virtualized viewport, not shelf hover. */
export function useConversationNavigation(options: NavigationOptions) {
  const entries = useMemo<readonly IndexedShelfEntry[]>(() => {
    const positions = new Map<string, number>();
    options.items.forEach((item, index) => {
      if (item.kind === 'text' && item.role === 'user') positions.set(item.id, index);
    });
    return conversationEntries(options.messages).flatMap((entry) => {
      const index = positions.get(entry.id);
      return index === undefined ? [] : [{ ...entry, index }];
    });
  }, [options.items, options.messages]);
  const latest = useRef({ entries, options });
  latest.current = { entries, options };
  const [readingId, setReadingId] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const frame = useRef<number | null>(null);

  const measure = useCallback((): void => {
    frame.current = null;
    const { entries: questions, options: current } = latest.current;
    const scroller = current.scrollerRef.current;
    if (!scroller) return;
    const rows = [...scroller.querySelectorAll<HTMLElement>('.conversation-row[data-index]')];
    if (pending.current) {
      const id = pending.current;
      if (!questions.some((entry) => entry.id === id)) {
        pending.current = null;
        return;
      }
      const target = rows.find((row) => row.dataset.conversationQuestion === id);
      if (!target) return;
      target.focus({ preventScroll: true });
      delete target.dataset.conversationLocated;
      void target.offsetHeight;
      target.dataset.conversationLocated = 'true';
      pending.current = null;
    }
    const top = scroller.getBoundingClientRect().top + 1;
    const visible = rows.find((row) => row.getBoundingClientRect().bottom > top);
    if (visible) setReadingId(entryAtRow(questions, Number(visible.dataset.index)));
    else if (rows.length) setReadingId(questions.at(-1)?.id ?? null);
  }, []);
  const schedule = useCallback((): void => {
    if (frame.current === null) frame.current = requestAnimationFrame(measure);
  }, [measure]);

  useLayoutEffect(() => {
    const node = options.scrollerRef.current;
    node?.addEventListener('scroll', schedule, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (node) observer?.observe(node);
    // A virtual target can mount after the range callback; wait for DOM work,
    // rather than polling every frame while a pane is hidden.
    const mutations =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
    if (node) mutations?.observe(node, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      node?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
      mutations?.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      pending.current = null;
    };
  }, [options.scrollerRef, schedule]);
  useLayoutEffect(schedule, [entries, schedule]);

  const navigate = useCallback(
    (id: string): void => {
      const { entries: questions, options: current } = latest.current;
      const entry = questions.find((question) => question.id === id);
      if (!entry || !current.virtuosoRef.current) return;
      current.pauseFollow();
      pending.current = id;
      setReadingId(id);
      current.virtuosoRef.current.scrollToIndex({
        index: entry.index,
        align: 'start',
        offset: -12,
        behavior: 'auto',
      });
      schedule();
    },
    [schedule],
  );

  return {
    entries,
    activeId: entries.some((entry) => entry.id === readingId)
      ? readingId
      : (entries.at(-1)?.id ?? null),
    navigate,
    rangeChanged: schedule,
  };
}
