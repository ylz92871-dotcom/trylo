import { bookEdgeMarkup } from './book-motion';
import type { ShelfEntry } from './entries';

let nextPanel = 0;
export function shelfMarkup(): string {
  const id = `conversation-shelf-panel-${++nextPanel}`;
  return `<button type="button" class="shelf-launcher" aria-label="展开对话书架" aria-expanded="false" aria-controls="${id}"><svg class="launcher-books" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4v11h12M6.5 5v7M10 4v8M13.5 6v6"/></svg><svg class="launcher-close" viewBox="0 0 16 16" aria-hidden="true"><path d="m10 4-4 4 4 4"/></svg></button><div class="shelf-panel" id="${id}" aria-hidden="true" inert><button type="button" class="shelf-page shelf-prev" aria-label="更早的提问"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg></button><div class="shelf-books"></div><button type="button" class="shelf-page shelf-next" aria-label="后面的提问"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button></div>`;
}

export function renderFrame(host: HTMLElement, count: number, row: number): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('shelf-frame');
  svg.setAttribute('viewBox', `0 0 22 ${count * row + 8}`);
  svg.setAttribute('aria-hidden', 'true');
  const rail = document.createElementNS(svg.namespaceURI, 'path');
  const back = document.createElementNS(svg.namespaceURI, 'path');
  rail.setAttribute('class', 'case-rail');
  back.setAttribute('class', 'case-back');
  const ledges: string[] = [],
    backs: string[] = [];
  for (let start = 0; start < count; start += 12) {
    const y = Math.min(count, start + 12) * row + 2.5;
    ledges.push(`M.75 ${y}H17v-1.5`);
    backs.push(`M.75 ${start * row + 4}V${y}`);
  }
  rail.setAttribute('d', ledges.join(''));
  back.setAttribute('d', backs.join(''));
  svg.append(back, rail);
  host.append(svg);
}

export function updateBook(
  book: HTMLElement,
  item: ShelfEntry,
  ordinal: number,
  total: number,
): void {
  book
    .querySelector<HTMLButtonElement>('.book-trigger')!
    .setAttribute('aria-label', `第 ${ordinal + 1} 次提问：${item.title}`);
  const fields = {
    '.page-number': `${String(ordinal + 1).padStart(2, '0')} / ${total}`,
    '.page-question': item.title,
    '.page-answer': item.excerpt,
  };
  for (const [selector, text] of Object.entries(fields)) {
    const node = book.querySelector<HTMLElement>(selector)!;
    if (node.textContent !== text) node.textContent = text;
  }
  book.querySelector<HTMLElement>('.page-answer')!.hidden = !item.excerpt;
}

export function createBook(item: ShelfEntry, ordinal: number, total: number): HTMLElement {
  const book = document.createElement('div');
  book.className = 'shelf-book';
  book.dataset.book = item.id;
  book.dataset.ordinal = String(ordinal);
  book.dataset.open = 'false';
  book.style.setProperty('--book-width', '29px');
  book.style.setProperty('--book-thickness', '1');
  book.innerHTML = `<button type="button" class="book-trigger" aria-expanded="false"></button><span class="book-viewport"><span class="book-pull"><span class="book-plan" aria-hidden="true">${bookEdgeMarkup()}</span><div class="book-page" role="presentation" aria-hidden="true"><span class="page-content"><span class="page-meta"><span class="page-number"></span><span class="current-reading-label">当前阅读</span></span><span class="page-question"></span><span class="page-answer"></span><span class="page-action">定位对话 <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M3 8h9M8 4l4 4-4 4"/></svg></span></span></div></span></span>`;
  book.querySelector<HTMLElement>('.book-page')!.inert = true;
  updateBook(book, item, ordinal, total);
  return book;
}
