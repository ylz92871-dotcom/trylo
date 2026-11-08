import {
  readShelfMetrics,
  layoutShelf,
  measureShelfPage,
  positionShelf,
  showShelfInk,
} from './shelf-layout';
import { createBookMotion, type BookMotion } from './book-motion';
import { BookPreviewInk } from './book-preview-ink';
import { createBook, renderFrame, shelfMarkup, updateBook } from './shelf-dom';
import { wireShelfInput } from './shelf-input';
import type { ShelfEntry } from './entries';

interface Point {
  x: number;
  y: number;
}
export interface ShelfMetrics {
  row: number;
  pager: number;
  pageWidth: number;
  preferredHeight: number;
  pullDistance: number;
  duration: number;
  maxBooks: number;
  capacityRow: number;
  preferredRow: number;
}

/** Owns transient shelf presentation; the conversation owner performs navigation. */
export class BookshelfView {
  readonly signal = new AbortController();
  readonly motions = new Map<string, BookMotion>();
  readonly ink: BookPreviewInk;
  readonly launcher: HTMLButtonElement;
  readonly panel: HTMLElement;
  readonly books: HTMLElement;
  readonly previous: HTMLButtonElement;
  readonly next: HTMLButtonElement;
  readonly motionPreference: MediaQueryList | null;
  items: readonly ShelfEntry[] = [];
  activeId: string | null = null;
  openId: string | null = null;
  pointedId: string | null = null;
  start = 0;
  pageSize = 1;
  height = 640;
  engaged = false;
  keyboard = false;
  suppressHover = false;
  expanded = false;
  dirty = true;
  pointerSample: Point | null = null;
  leaveTimer: ReturnType<typeof setTimeout> | undefined;
  intentTimer: ReturnType<typeof setTimeout> | undefined;
  focusTimer: ReturnType<typeof setTimeout> | undefined;
  lastWheel: number | undefined;
  pageHeight: number | undefined;
  metrics: ShelfMetrics;

  constructor(
    readonly root: HTMLElement,
    readonly onNavigate: (id: string) => void,
  ) {
    root.dataset.expanded = 'false';
    root.innerHTML = shelfMarkup();
    this.ink = new BookPreviewInk(root, (id) => this.navigate(id));
    this.launcher = root.querySelector<HTMLButtonElement>('.shelf-launcher')!;
    this.panel = root.querySelector<HTMLElement>('.shelf-panel')!;
    this.books = root.querySelector<HTMLElement>('.shelf-books')!;
    this.previous = root.querySelector<HTMLButtonElement>('.shelf-prev')!;
    this.next = root.querySelector<HTMLButtonElement>('.shelf-next')!;
    this.metrics = this.readMetrics();
    this.pageSize = this.metrics.maxBooks;
    this.motionPreference =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    wireShelfInput.call(this);
    this.updateLauncher();
  }
  updateLauncher() {
    this.launcher.setAttribute('aria-expanded', String(this.expanded));
    this.launcher.setAttribute(
      'aria-label',
      this.expanded ? '收起对话书架' : `展开对话书架，共 ${this.items.length} 次提问`,
    );
    this.launcher.title = this.expanded ? '收起对话书架' : `对话书架 · ${this.items.length} 次提问`;
  }
  expandPanel() {
    if (this.items.length < 2) return;
    this.expanded = true;
    this.engaged = true;
    this.suppressHover = false;
    this.root.dataset.expanded = 'true';
    this.panel.inert = false;
    this.panel.removeAttribute('aria-hidden');
    const i = Math.max(
      0,
      this.items.findIndex((item) => item.id === this.activeId),
    );
    const start = this.rangeStartFor(i);
    if (start !== this.start) {
      this.start = start;
      this.dirty = true;
    }
    if (this.dirty || !this.bookElements().length) this.render();
    else this.updateCurrent();
    this.position();
    this.updateLauncher();
  }
  collapsePanel({ restoreFocus = false } = {}) {
    clearTimeout(this.leaveTimer);
    clearTimeout(this.intentTimer);
    this.closeBook({ instant: true });
    for (const [id, motion] of this.motions) {
      motion.seek(0);
      const book = this.findBook(id);
      if (book) book.dataset.returning = 'false';
    }
    this.expanded = false;
    this.engaged = false;
    this.suppressHover = false;
    this.root.dataset.expanded = 'false';
    this.panel.inert = true;
    this.panel.setAttribute('aria-hidden', 'true');
    this.updateLauncher();
    if (restoreFocus) this.launcher.focus({ preventScroll: true });
  }
  discardBooks() {
    this.closeBook({ instant: true });
    for (const motion of this.motions.values()) motion.destroy();
    this.motions.clear();
    this.books.replaceChildren();
    this.dirty = true;
  }
  rangeStartFor(index: number) {
    return Math.max(
      0,
      Math.min(
        Math.floor(index / this.pageSize) * this.pageSize,
        Math.max(0, this.items.length - this.pageSize),
      ),
    );
  }
  bookElements() {
    return [...this.books.querySelectorAll<HTMLElement>(':scope > [data-book]')];
  }
  findBook(id: string | null) {
    return this.bookElements().find((book) => book.dataset.book === id);
  }
  readMetrics = readShelfMetrics;
  setItems(items: readonly ShelfEntry[]): void {
    const sameIds =
      this.items.length === items.length &&
      this.items.every((item, index) => item.id === items[index]?.id);
    const previousFirst = this.items[0]?.id;
    this.items = items;
    this.root.hidden = items.length < 2;
    if (!sameIds) {
      if (previousFirst && previousFirst !== items[0]?.id) this.collapsePanel();
      this.discardBooks();
      this.activeId = items.some((item) => item.id === this.activeId)
        ? this.activeId
        : (items[0]?.id ?? null);
      this.start = this.rangeStartFor(
        Math.max(
          0,
          items.findIndex((item) => item.id === this.activeId),
        ),
      );
      if (items.length < 2) this.collapsePanel();
      if (this.expanded) this.render();
    } else if (this.expanded) {
      for (const book of this.bookElements()) {
        const index = Number(book.dataset.ordinal),
          item = items[index];
        if (item) updateBook(book, item, index, items.length);
      }
      const opened = this.openId ? this.findBook(this.openId) : undefined;
      if (opened) {
        this.measurePage(opened);
        this.showInk(opened, true);
      }
    }
    this.updateCurrent();
    this.updateLauncher();
  }
  layout = layoutShelf;
  measurePage = measureShelfPage;
  position = positionShelf;
  render(): void {
    if (!this.expanded) {
      this.dirty = true;
      return;
    }
    this.discardBooks();
    const stop = Math.min(this.items.length, this.start + this.pageSize),
      count = stop - this.start;
    if (count > 0) renderFrame(this.books, count, this.metrics.row);
    for (let index = this.start; index < stop; index++) {
      const item = this.items[index];
      if (item) this.books.append(createBook(item, index, this.items.length));
    }
    this.previous.disabled = this.start === 0;
    this.next.disabled = stop >= this.items.length;
    this.root.setAttribute('aria-label', `对话书架，共 ${this.items.length} 次提问`);
    this.dirty = false;
    this.updateCurrent();
    this.position();
  }
  setActive(id: string | null) {
    if (!this.items.some((item) => item.id === id)) return;
    if (id === this.activeId) {
      if (this.expanded) this.updateCurrent();
      return;
    }
    this.activeId = id;
    if (!this.expanded || !this.engaged) this.revealActive();
    else this.updateCurrent();
  }
  revealActive() {
    const i = this.items.findIndex((item) => item.id === this.activeId),
      start = this.rangeStartFor(Math.max(0, i));
    if (start !== this.start) {
      this.start = start;
      this.dirty = true;
      if (this.expanded) this.render();
    } else if (this.expanded) this.updateCurrent();
  }
  updateCurrent() {
    const books = this.bookElements(),
      current = books.find((book) => book.dataset.book === this.activeId) ?? books[0];
    for (const book of books) {
      const selected = book.dataset.book === this.activeId;
      book.setAttribute('aria-current', selected ? 'location' : 'false');
      const trigger = book.querySelector<HTMLButtonElement>('.book-trigger')!;
      trigger.setAttribute('aria-current', selected ? 'location' : 'false');
      trigger.tabIndex = book === current ? 0 : -1;
    }
    this.ink.setCurrent(this.openId === this.activeId);
  }
  motionFor(id: string) {
    let motion = this.motions.get(id);
    const book = this.findBook(id);
    if (!book) return null;
    const openDown = book.dataset.direction === 'down';
    if (motion && motion.openDown !== openDown) {
      motion.destroy();
      this.motions.delete(id);
      motion = undefined;
    }
    if (!motion) {
      motion = createBookMotion(book, { ...this.metrics, openDown });
      this.motions.set(id, motion);
    }
    return motion;
  }
  isReduced() {
    return this.motionPreference?.matches ?? false;
  }
  settleReducedMotion() {
    if (!this.isReduced()) return;
    this.ink.finish();
    for (const [id, motion] of this.motions) {
      motion.seek(id === this.openId ? 1 : 0);
      const book = this.findBook(id);
      if (book) book.dataset.returning = 'false';
    }
  }
  openBook(id: string, { instant = false } = {}) {
    clearTimeout(this.intentTimer);
    clearTimeout(this.leaveTimer);
    if (!this.expanded || this.openId === id) return;
    const book = this.findBook(id);
    if (!book) return;
    this.closeBook();
    this.engaged = true;
    this.openId = id;
    this.setPointed(id);
    book.dataset.returning = 'false';
    book.dataset.open = 'true';
    book.querySelector<HTMLButtonElement>('.book-trigger')!.setAttribute('aria-expanded', 'true');
    const page = book.querySelector<HTMLElement>('.book-page')!;
    page.inert = false;
    this.measurePage(book);
    this.showInk(book, instant);
    const motion = this.motionFor(id)!,
      duration = this.readMetrics().duration;
    if (motion.duration !== duration) motion.retime(duration);
    motion.open(instant || this.isReduced());
    this.settleReducedMotion();
  }
  closeBook({ instant = false } = {}) {
    clearTimeout(this.intentTimer);
    if (!this.openId) return;
    const id = this.openId,
      book = this.findBook(id);
    this.openId = null;
    this.ink.hide();
    this.setPointed(null);
    if (!book) return;
    book.dataset.open = 'false';
    book.dataset.returning = 'true';
    book.querySelector<HTMLButtonElement>('.book-trigger')!.setAttribute('aria-expanded', 'false');
    const page = book.querySelector<HTMLElement>('.book-page')!;
    page.inert = true;
    page.setAttribute('aria-hidden', 'true');
    this.motions.get(id)?.close(instant || this.isReduced(), () => {
      book.dataset.returning = 'false';
    });
    this.settleReducedMotion();
  }
  showInk = showShelfInk;
  setPointed(id: string | null) {
    if (this.pointedId === id) return;
    this.pointedId = id;
    for (const book of this.bookElements()) book.dataset.pointed = String(book.dataset.book === id);
  }
  movingTowardPage(previous: Point | null, current: Point) {
    if (!previous || !this.openId || current.x <= previous.x + 1) return false;
    if (current.x - previous.x < Math.abs(current.y - previous.y) * 0.45) return false;
    const page = this.findBook(this.openId)?.querySelector<HTMLElement>('.book-page')!;
    const inkBounds = this.ink.bounds;
    if (!inkBounds && (!page || Number(getComputedStyle(page).opacity) < 0.9)) return false;
    const rect = inkBounds ?? page.getBoundingClientRect(),
      distance = rect.left - previous.x;
    if (distance <= 0 || current.x >= rect.left) return false;
    const fraction = (current.x - previous.x) / distance;
    const top = previous.y + (rect.top - previous.y) * fraction - 3;
    const bottom = previous.y + (rect.bottom - previous.y) * fraction + 3;
    return current.y >= top && current.y <= bottom;
  }
  navigate(id: string) {
    this.collapsePanel();
    this.onNavigate(id);
  }
  page(direction: number) {
    if (!this.expanded) return;
    const start = Math.max(
      0,
      Math.min(
        Math.max(0, this.items.length - this.pageSize),
        this.start + direction * this.pageSize,
      ),
    );
    if (start === this.start) return;
    this.engaged = true;
    this.start = start;
    this.render();
  }
  onKey(event: KeyboardEvent) {
    this.keyboard = true;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.collapsePanel({ restoreFocus: true });
      return;
    }
    if (event.target === this.launcher && event.key === 'ArrowDown') {
      event.preventDefault();
      this.expandPanel();
      const current = this.findBook(this.activeId) ?? this.bookElements()[0];
      current?.querySelector<HTMLButtonElement>('.book-trigger')!.focus({ preventScroll: true });
      return;
    }
    const eventTarget = event.target instanceof Element ? event.target : null;
    const book =
      eventTarget?.closest<HTMLElement>('[data-book]') ??
      (eventTarget?.closest('.shelf-ink') && this.openId ? this.findBook(this.openId) : null);
    if (!book || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const i = Number(book.dataset.ordinal),
      target =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? this.items.length - 1
            : Math.max(
                0,
                Math.min(this.items.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)),
              );
    this.engaged = true;
    const page = this.rangeStartFor(target);
    if (page !== this.start) {
      this.start = page;
      this.render();
    }
    const next = this.bookElements().find((book) => Number(book.dataset.ordinal) === target);
    if (next) {
      for (const other of this.bookElements())
        other.querySelector<HTMLButtonElement>('.book-trigger')!.tabIndex = other === next ? 0 : -1;
      next.querySelector<HTMLButtonElement>('.book-trigger')!.focus({ preventScroll: true });
      this.openBook(next.dataset.book!);
    }
  }
  destroy() {
    clearTimeout(this.focusTimer);
    this.ink.destroy();
    clearTimeout(this.leaveTimer);
    clearTimeout(this.intentTimer);
    this.signal.abort();
    for (const motion of this.motions.values()) motion.destroy();
    this.root.replaceChildren();
  }
}
