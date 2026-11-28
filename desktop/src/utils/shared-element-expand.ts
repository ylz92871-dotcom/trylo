import { prefersReducedMotion } from './use-presence-transition';

function isJsdom(): boolean {
  return typeof navigator === 'undefined' || /\bjsdom\b/i.test(navigator.userAgent);
}

function isRectVisibleInViewport(rect: DOMRect): boolean {
  if (typeof window === 'undefined' || rect.width <= 0 || rect.height <= 0) return false;
  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

/**
 * Shared-element FLIP expansion (SPT 10.6):
 * Animates a target media element from a source thumbnail rect while keeping aspect ratio,
 * and collapses back to the source only if the source is still mounted and visible.
 */
export function animateExpandFromSource(
  sourceEl: HTMLElement | null,
  targetEl: HTMLElement | null,
): void {
  if (!sourceEl || !targetEl || prefersReducedMotion() || isJsdom() || typeof targetEl.animate !== 'function') {
    return;
  }

  const from = sourceEl.getBoundingClientRect();
  const to = targetEl.getBoundingClientRect();
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) return;

  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const uniformScale = Math.max(0.15, Math.min(from.width / to.width, from.height / to.height));

  targetEl.animate(
    [
      {
        opacity: 0.72,
        transform: `translate(${dx}px, ${dy}px) scale(${uniformScale})`,
      },
      {
        opacity: 1,
        transform: 'translate(0px, 0px) scale(1)',
      },
    ],
    {
      duration: 240,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    },
  );
}

export function animateCollapseToSource(
  sourceEl: HTMLElement | null,
  targetEl: HTMLElement | null,
  onDone: () => void,
): void {
  if (!targetEl || prefersReducedMotion() || isJsdom() || typeof targetEl.animate !== 'function') {
    onDone();
    return;
  }

  const to = targetEl.getBoundingClientRect();
  const from = sourceEl?.isConnected ? sourceEl.getBoundingClientRect() : null;
  const canReturnToSource = Boolean(from && isRectVisibleInViewport(from) && to.width > 0 && to.height > 0);

  const endKeyframe: Keyframe = canReturnToSource && from
    ? {
        opacity: 0,
        transform: `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px, ${from.top + from.height / 2 - (to.top + to.height / 2)}px) scale(${Math.max(0.15, Math.min(from.width / to.width, from.height / to.height))})`,
      }
    : {
        opacity: 0,
        transform: 'scale(0.96)',
      };

  const anim = targetEl.animate(
    [{ opacity: 1, transform: 'translate(0px, 0px) scale(1)' }, endKeyframe],
    {
      duration: 160,
      easing: 'cubic-bezier(0.4, 0, 1, 1)',
      fill: 'forwards',
    },
  );

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    anim.cancel();
    onDone();
  };
  anim.onfinish = finish;
  window.setTimeout(finish, 180);
}
