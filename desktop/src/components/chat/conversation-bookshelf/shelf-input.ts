import type { BookshelfView } from './shelf-view';

/** Native input changes only this view's transient presentation state. */
export function wireShelfInput(this: BookshelfView): void {
  const root = this.root;
  const listen = <K extends keyof GlobalEventHandlersEventMap>(
    target: EventTarget,
    type: K,
    handler: (event: GlobalEventHandlersEventMap[K]) => void,
  ): void =>
    target.addEventListener(type, handler as EventListener, { signal: this.signal.signal });
  if (this.motionPreference)
    listen(this.motionPreference, 'change', () => this.settleReducedMotion());
  listen(root, 'pointerenter', () => {
    clearTimeout(this.leaveTimer);
    this.engaged = true;
    this.pointerSample = null;
  });
  listen(root, 'pointerdown', () => {
    this.keyboard = false;
  });
  listen(root, 'pointerleave', () => {
    this.suppressHover = false;
    this.leaveTimer = setTimeout(() => {
      if (this.keyboard && root.contains(document.activeElement)) return;
      this.engaged = false;
      this.closeBook();
    }, 210);
  });
  listen(root, 'pointermove', (event) => {
    this.keyboard = false;
    const previous = this.pointerSample;
    this.pointerSample = { x: event.clientX, y: event.clientY };
    clearTimeout(this.intentTimer);
    const trigger =
      event.target instanceof Element ? event.target.closest<HTMLElement>('.book-trigger') : null;
    if (!trigger || this.suppressHover) return;
    const id = trigger.closest<HTMLElement>('[data-book]')!.dataset.book!;
    if (id === this.openId) {
      this.setPointed(id);
      return;
    }
    // Only diagonal travel toward the already-open page has a short guard.
    // Pure vertical scanning has no dwell threshold.
    if (this.movingTowardPage(previous, this.pointerSample)) {
      this.intentTimer = setTimeout(() => this.openBook(id), 75);
    } else this.openBook(id);
  });
  listen(this.books, 'pointerout', (event) => {
    const book =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-book]') : null;
    if (book && !book.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null))
      clearTimeout(this.intentTimer);
  });
  listen(root, 'focusin', (event) => {
    this.engaged = true;
    const book =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-book]') : null;
    if (book) this.openBook(book.dataset.book!);
  });
  listen(root, 'focusout', () => {
    clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => {
      if (!root.contains(document.activeElement) && !root.matches(':hover')) {
        this.keyboard = false;
        this.engaged = false;
        this.closeBook();
      }
    }, 0);
  });
  listen(this.launcher, 'click', () => (this.expanded ? this.collapsePanel() : this.expandPanel()));
  listen(document, 'pointerdown', (event) => {
    if (this.expanded && !root.contains(event.target instanceof Node ? event.target : null))
      this.collapsePanel();
  });
  this.books.addEventListener(
    'wheel',
    (event) => {
      if (
        !this.expanded ||
        this.items.length <= this.pageSize ||
        (event.target instanceof Element && event.target.closest('.book-page'))
      )
        return;
      event.preventDefault();
      const now = performance.now();
      if (now - (this.lastWheel ?? -Infinity) < 160 || Math.abs(event.deltaY) < 2) return;
      this.lastWheel = now;
      this.page(event.deltaY > 0 ? 1 : -1);
    },
    { passive: false, signal: this.signal.signal },
  );
  listen(this.previous, 'click', () => this.page(-1));
  listen(this.next, 'click', () => this.page(1));
  listen(this.books, 'click', (event) => {
    const book =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-book]') : null;
    if (book && event.target instanceof Element && event.target.closest('.book-trigger,.book-page'))
      this.navigate(book.dataset.book!);
  });
  listen(root, 'keydown', (event) => this.onKey(event));
}
