import { useLayoutEffect, useRef, type ReactElement, type RefObject } from 'react';
import type { ShelfEntry } from './entries';
import { BookshelfView } from './shelf-view';

interface Props {
  readonly entries: readonly ShelfEntry[];
  readonly activeId: string | null;
  readonly onNavigate: (id: string) => void;
  readonly containerRef: RefObject<HTMLElement>;
  readonly viewportRef: RefObject<HTMLElement>;
  readonly contentRef?: RefObject<HTMLElement>;
}

/** Binds the approved visual view to the existing timeline viewport. */
export function ConversationBookshelf(props: Props): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const view = useRef<BookshelfView | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const shelf = new BookshelfView(node, (id) => latest.current.onNavigate(id));
    view.current = shelf;
    shelf.setItems(latest.current.entries);
    shelf.setActive(latest.current.activeId);
    let frame: number | null = null;
    const measure = (): void => {
      frame = null;
      const container = latest.current.containerRef.current;
      const viewport = latest.current.viewportRef.current;
      if (!container || !viewport) return;
      const bounds = container.getBoundingClientRect(),
        scroll = viewport.getBoundingClientRect();
      if (scroll.height <= 0) return;
      const top = scroll.top - bounds.top;
      node.style.top = `${top}px`;
      node.style.height = `${scroll.height}px`;
      const row =
        latest.current.contentRef?.current ??
        viewport.querySelector<HTMLElement>('.conversation-row');
      const gutter = row
        ? row.getBoundingClientRect().left - bounds.left
        : scroll.left - bounds.left;
      shelf.layout(scroll.height, { gutter, width: bounds.width });
    };
    const schedule = (): void => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    for (const element of [props.containerRef.current, props.viewportRef.current])
      if (element) observer?.observe(element);
    // Rows may mount after Virtuoso's first measurement pass.
    const mutations =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
    if (props.viewportRef.current)
      mutations?.observe(props.viewportRef.current, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    measure();
    schedule();
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      shelf.destroy();
      view.current = null;
    };
  }, [props.containerRef, props.viewportRef]);

  useLayoutEffect(() => {
    view.current?.setItems(props.entries);
  }, [props.entries]);
  useLayoutEffect(() => {
    view.current?.setActive(props.activeId);
  }, [props.activeId]);
  return <div ref={root} className="conversation-bookshelf" aria-label="对话书架" />;
}
