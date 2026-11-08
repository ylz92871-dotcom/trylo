import type { BookshelfView, ShelfMetrics } from './shelf-view';

/** Geometry belongs to the shelf view and consumes the actual timeline viewport. */
export function readShelfMetrics(this: BookshelfView): ShelfMetrics {
  const style = getComputedStyle(this.root),
    read = (name: string) => parseFloat(style.getPropertyValue(name));
  return {
    row: read('--shelf-row'),
    pager: read('--shelf-pager'),
    pageWidth: read('--page-width'),
    preferredHeight: read('--page-preferred-height'),
    pullDistance: read('--pull-distance'),
    duration: read('--motion-ms'),
    maxBooks: read('--max-books'),
    capacityRow: read('--shelf-capacity-row'),
    preferredRow: read('--shelf-row-preferred'),
  };
}

export function layoutShelf(
  this: BookshelfView,
  height: number,
  { gutter = 240, width = 320 }: { gutter?: number; width?: number } = {},
) {
  const old = this.metrics,
    open = this.openId;
  this.height = height;
  this.metrics = this.readMetrics();
  const presentation = gutter >= 188 ? 'leaf' : 'overlay';
  const pageWidth =
    presentation === 'leaf'
      ? Math.min(196, Math.max(160, Math.floor(gutter - 24)))
      : Math.min(196, Math.max(144, Math.floor(width - 48)));
  this.root.dataset.presentation = presentation;
  this.root.style.setProperty('--page-width', pageWidth + 'px');
  this.metrics.pageWidth = pageWidth;
  this.pageHeight = Math.max(
    100,
    Math.min(
      this.metrics.preferredHeight,
      height - 2 * this.metrics.pager - this.metrics.capacityRow - 16,
    ),
  );
  this.root.style.setProperty('--page-height', this.pageHeight + 'px');
  this.root.dataset.compactPage = String(this.pageHeight < 140);
  const minimum = Math.max(8, this.pageHeight - this.metrics.pager + 3);
  // Taller hit rows must fit physically; all remaining items stay pageable.
  const fittingRows = Math.floor(
    (height - 2 * this.metrics.pager - 52) / this.metrics.preferredRow,
  );
  const count = Math.max(
    1,
    Math.min(
      this.metrics.maxBooks,
      fittingRows,
      Math.floor((height - 2 * minimum - 2 * this.metrics.pager) / this.metrics.capacityRow),
    ),
  );
  const visible = Math.min(count, Math.max(1, this.items.length));
  this.metrics.row = Math.min(
    this.metrics.preferredRow,
    Math.max(this.metrics.capacityRow, (height - 2 * this.metrics.pager - 52) / visible),
  );
  this.root.style.setProperty('--shelf-row', this.metrics.row + 'px');
  const changed =
    count !== this.pageSize ||
    old.row !== this.metrics.row ||
    old.pageWidth !== this.metrics.pageWidth;
  if (changed) {
    this.pageSize = count;
    this.dirty = true;
    const index = Math.max(
      0,
      this.items.findIndex((item) => item.id === (open ?? this.activeId)),
    );
    this.start = this.rangeStartFor(index);
    if (this.expanded) {
      this.render();
      if (open && this.findBook(open)) this.openBook(open, { instant: true });
    }
  }
  this.position();
  if (this.expanded && this.openId) {
    const book = this.findBook(this.openId);
    if (book) {
      this.measurePage(book);
      this.showInk(book);
      const motion = this.motions.get(this.openId);
      if (motion && motion.openDown !== (book.dataset.direction === 'down'))
        this.motionFor(this.openId)!.open(true);
    }
  }
}

export function measureShelfPage(this: BookshelfView, book: HTMLElement) {
  const page = book.querySelector<HTMLElement>('.book-page')!,
    content = page.querySelector<HTMLElement>('.page-content')!;
  content.style.height = 'auto';
  const natural = content.offsetHeight;
  content.style.height = '';
  const leafHeight = Math.max(
    106,
    Math.min(this.pageHeight ?? this.metrics.preferredHeight, natural),
  );
  const bounds = this.root.getBoundingClientRect(),
    anchor = book.getBoundingClientRect();
  const above = anchor.top - bounds.top - 8,
    below = bounds.bottom - anchor.bottom - 8;
  book.dataset.direction = above < leafHeight && below > above ? 'down' : 'up';
  book.style.setProperty('--leaf-height', leafHeight + 'px');
}

export function positionShelf(this: BookshelfView) {
  const count = Math.min(this.pageSize, Math.max(1, this.items.length - this.start));
  const total = count * this.metrics.row + 2 * this.metrics.pager;
  this.panel.style.height = total + 'px';
  const top = Math.max(8, Math.min(this.height - total - 34, (this.height - total - 24) / 2));
  this.panel.style.top = top + 'px';
  this.root.style.setProperty(
    '--shelf-close-top',
    Math.min(this.height - 26, top + total + 4) + 'px',
  );
}

export function showShelfInk(this: BookshelfView, book: HTMLElement, instant = false) {
  const root = this.root.getBoundingClientRect();
  const row = book.getBoundingClientRect();
  const page = book.querySelector<HTMLElement>('.book-page')!;
  const content = page.querySelector<HTMLElement>('.page-content')!;
  const pageStyle = getComputedStyle(page);
  const contentStyle = getComputedStyle(content);
  const number = (
    style: CSSStyleDeclaration,
    name:
      | 'borderLeftWidth'
      | 'borderTopWidth'
      | 'borderRightWidth'
      | 'borderBottomWidth'
      | 'paddingLeft'
      | 'paddingTop'
      | 'paddingRight'
      | 'paddingBottom'
      | 'left',
  ) => Number.parseFloat(style[name]);
  const height = Number.parseFloat(book.style.getPropertyValue('--leaf-height'));
  const down = book.dataset.direction === 'down';

  // Use the final paper's content box, not its current 3D bounding box.
  const hinge = row.top - root.top + this.metrics.row / 2;
  const paperX =
    row.left -
    root.left +
    number(getComputedStyle(book.querySelector<HTMLElement>('.book-pull')!), 'left') +
    this.metrics.pullDistance;
  const paperY = hinge - (down ? 0 : height);
  const insetX = number(pageStyle, 'borderLeftWidth') + number(contentStyle, 'paddingLeft');
  const insetY = number(pageStyle, 'borderTopWidth') + number(contentStyle, 'paddingTop');
  const width =
    this.metrics.pageWidth -
    insetX -
    number(pageStyle, 'borderRightWidth') -
    number(contentStyle, 'paddingRight');
  const innerHeight =
    height -
    insetY -
    number(pageStyle, 'borderBottomWidth') -
    number(contentStyle, 'paddingBottom');

  this.ink.show({
    id: book.dataset.book!,
    content,
    rect: { x: paperX + insetX, y: paperY + insetY, width, height: innerHeight },
    current: book.dataset.book === this.activeId,
    reduced: instant || this.isReduced(),
  });
}
