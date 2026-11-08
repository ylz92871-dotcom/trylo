/** One readable text plane above the unchanged animated paper. */
interface InkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface InkContent {
  id: string;
  content: HTMLElement;
  rect: InkRect;
  current: boolean;
  reduced: boolean;
}
export class BookPreviewInk {
  id: string | null = null;
  transition: Animation | null = null;
  readonly element: HTMLButtonElement;
  private contentText = '';
  constructor(host: HTMLElement, onNavigate: (id: string) => void) {
    this.id = null;
    this.transition = null;
    this.element = document.createElement('button');
    this.element.className = 'shelf-ink';
    this.element.hidden = true;
    this.element.inert = true;
    this.element.tabIndex = -1;
    this.element.addEventListener('click', () => {
      if (this.id !== null) onNavigate(this.id);
    });
    host.append(this.element);
  }

  show({ id, content, rect, current, reduced }: InkContent) {
    const changed = this.id !== id;
    this.id = id;
    this.element.dataset.bookId = id;
    this.setCurrent(current);
    Object.assign(this.element.style, {
      left: rect.x + 'px',
      top: rect.y + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
    });

    if (changed || this.contentText !== content.textContent) {
      this.contentText = content.textContent ?? '';
      this.element.replaceChildren(content.cloneNode(true));
      this.element.setAttribute(
        'aria-label',
        content.querySelector('.page-question')!.textContent + '，定位对话',
      );
    }
    this.element.hidden = false;
    this.element.inert = false;
    this.element.tabIndex = 0;

    if (changed) {
      this.finish();
      if (!reduced) {
        // Keep full ink opacity; blur is a short transition, never a read gate.
        this.transition = this.element.animate(
          [{ filter: 'blur(.45px)' }, { filter: 'blur(0px)' }],
          {
            duration: 90,
            easing: 'ease-out',
          },
        );
      }
    }
  }

  setCurrent(current: boolean) {
    this.element.dataset.current = String(current);
  }

  get bounds() {
    return this.element.hidden ? null : this.element.getBoundingClientRect();
  }

  finish() {
    this.transition?.cancel();
    this.transition = null;
  }

  hide() {
    this.finish();
    this.id = null;
    this.element.hidden = true;
    this.element.inert = true;
    this.element.tabIndex = -1;
    delete this.element.dataset.bookId;
  }

  destroy() {
    this.hide();
    this.element.remove();
  }
}
