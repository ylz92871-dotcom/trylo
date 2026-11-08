/** One object slides straight out of its rack, then opens upward. */
const completeEdgeMarkup = `<span class="edge-paper"></span><svg class="edge-lines" viewBox="0 -2 1 12" preserveAspectRatio="none" aria-hidden="true"><path d="M0 -1.5H1M0 9.5H1"/><path class="inner-paper" d="M0 .5H1M0 7.5H1"/></svg><svg class="edge-binding" viewBox="0 -2 8 12" aria-hidden="true"><path d="M0 -1.5H1.5C5 -1.5 7 1 7 4C7 7 5 9.5 1.5 9.5H0"/><path class="inner-binding" d="M0 .5H1.2C3.6 .5 5.2 1.9 5.2 4C5.2 6.1 3.6 7.5 1.2 7.5H0"/></svg><span class="edge-fore"></span>`;
export function bookEdgeMarkup() {
  return `<svg class="book-profile" viewBox="0 0 24 8" preserveAspectRatio="none" aria-hidden="true"><path d="M10.5 2.2H20.8Q23 2.2 23 4Q23 5.8 20.8 5.8H10.5"/></svg><span class="book-complete" aria-hidden="true"></span>`;
}
export interface BookMotion {
  readonly animations: readonly Animation[];
  readonly openDown: boolean;
  readonly duration: number;
  readonly progress: number;
  open(instant: boolean, done?: () => void): void;
  close(instant: boolean, done?: () => void): void;
  retime(duration: number): void;
  seek(progress: number): void;
  destroy(): void;
}
interface MotionOptions {
  duration: number;
  pageWidth: number;
  pullDistance: number;
  openDown?: boolean;
}

export function createBookMotion(
  book: HTMLElement,
  { duration, pageWidth, pullDistance, openDown = false }: MotionOptions,
): BookMotion {
  const complete = book.querySelector<HTMLElement>('.book-complete')!;
  if (!complete.firstElementChild) complete.innerHTML = completeEdgeMarkup;
  const carriage = book.querySelector<HTMLElement>('.book-pull')!;
  const plan = book.querySelector<HTMLElement>('.book-plan')!;
  const page = book.querySelector<HTMLElement>('.book-page')!;
  const content = book.querySelector<HTMLElement>('.page-content')!;
  const style = getComputedStyle(book);
  const bookWidth = parseFloat(style.getPropertyValue('--book-width')) || 24;
  const thickness = parseFloat(style.getPropertyValue('--book-thickness')) || 1;
  let generation = 0;
  let length = duration;
  const easing = 'cubic-bezier(.22,.68,.22,1)';
  const angle = openDown ? 1 : -1;
  const definitions: [string, HTMLElement, Keyframe[]][] = [
    [
      'pull',
      carriage,
      [
        { offset: 0, transform: 'translateX(0px)', easing },
        { offset: 0.4, transform: `translateX(${pullDistance}px)` },
        { offset: 1, transform: `translateX(${pullDistance}px)` },
      ],
    ],
    [
      'thickness',
      plan,
      [
        { offset: 0, transform: `scaleY(${thickness})` },
        { offset: 0.4, transform: `scaleY(${thickness})`, easing },
        { offset: 1, transform: 'scaleY(.62)' },
      ],
    ],
    [
      'edge',
      plan,
      [
        { offset: 0, width: `${bookWidth}px` },
        { offset: 0.4, width: `${bookWidth}px`, easing },
        { offset: 0.74, width: `${pageWidth * 0.79}px`, easing },
        { offset: 1, width: `${pageWidth}px` },
      ],
    ],
    [
      'unfold',
      page,
      [
        {
          offset: 0,
          opacity: 0,
          transform: `perspective(900px) rotateX(${90 * angle}deg) scaleX(${bookWidth / pageWidth})`,
        },
        {
          offset: 0.4,
          opacity: 0,
          transform: `perspective(900px) rotateX(${90 * angle}deg) scaleX(${bookWidth / pageWidth})`,
        },
        {
          offset: 0.41,
          opacity: 1,
          transform: `perspective(900px) rotateX(${88 * angle}deg) scaleX(${bookWidth / pageWidth})`,
          easing,
        },
        {
          offset: 0.74,
          opacity: 1,
          transform: `perspective(900px) rotateX(${24 * angle}deg) scaleX(.79)`,
          easing,
        },
        { offset: 1, opacity: 1, transform: 'perspective(900px) rotateX(0deg) scaleX(1)' },
      ],
    ],
    [
      'content',
      content,
      [
        { offset: 0, opacity: 0, transform: 'translateY(2px)' },
        { offset: 0.8, opacity: 0, transform: 'translateY(2px)', easing: 'ease-out' },
        { offset: 1, opacity: 1, transform: 'translateY(0px)' },
      ],
    ],
  ];
  const animations = definitions.map(([name, element, frames]) => {
    const animation = element.animate(frames, { duration: length, fill: 'both', easing: 'linear' });
    animation.id = 'book-' + name;
    animation.pause();
    animation.currentTime = 0;
    return animation;
  });
  function go(forward: boolean, instant = false, done: () => void = () => {}) {
    const token = ++generation;
    if (
      instant ||
      (!forward && animations.every((animation) => Number(animation.currentTime ?? 0) <= 0))
    ) {
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = forward ? length : 0;
      }
      done();
      return;
    }
    for (const animation of animations) {
      animation.updatePlaybackRate(forward ? 1 : -1);
      animation.play();
    }
    Promise.all(animations.map((animation) => animation.finished))
      .then(() => {
        if (token === generation) done();
      })
      .catch((error) => {
        // A newer open/close or destroy may cancel a finished-animation promise.
        if (error?.name !== 'AbortError') throw error;
      });
  }
  return {
    animations,
    openDown,
    get duration() {
      return length;
    },
    get progress() {
      return Math.max(0, Math.min(1, Number(animations[0]!.currentTime ?? 0) / length));
    },
    open(instant, done) {
      go(true, instant, done);
    },
    close(instant, done) {
      go(false, instant, done);
    },
    retime(next) {
      const progress = this.progress;
      length = next;
      for (const animation of animations) {
        animation.effect!.updateTiming({ duration: next });
        animation.currentTime = progress * next;
      }
    },
    seek(progress) {
      ++generation;
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = Math.max(0, Math.min(1, progress)) * length;
      }
    },
    destroy() {
      ++generation;
      animations.forEach((animation) => animation.cancel());
    },
  };
}
