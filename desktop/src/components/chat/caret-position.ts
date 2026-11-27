export interface CaretTrigger {
  readonly trigger: '@' | '/';
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

export interface CaretCoords {
  readonly top: number;
  readonly left: number;
  readonly lineHeight: number;
}

/**
 * Detect `@query` or `/query` immediately before the caret when preceded by start-of-string or whitespace.
 */
export function detectTriggerAtCaret(text: string, caret: number): CaretTrigger | null {
  if (caret <= 0 || caret > text.length) return null;

  let index = caret - 1;
  while (index >= 0) {
    const ch = text[index]!;
    if (/\s/.test(ch)) return null;
    if (ch === '@' || ch === '/') {
      const atBoundary = index === 0 || /\s/.test(text[index - 1]!);
      if (atBoundary) {
        return {
          trigger: ch,
          query: text.slice(index + 1, caret),
          start: index,
          end: caret,
        };
      }
      // Inside a token (e.g. `@src/a`), `/` is a path separator, not a command prefix.
      if (ch === '@') return null;
    }
    index -= 1;
  }
  return null;
}

const MIRROR_PROPS = [
  'boxSizing',
  'width',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'tabSize',
] as const;

/**
 * Measure caret position relative to the textarea's top-left corner using a hidden mirror element.
 */
export function measureCaretCoords(textarea: HTMLTextAreaElement, position: number): CaretCoords {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { top: 0, left: 0, lineHeight: 20 };
  }

  const computed = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(computed.lineHeight) || 20;

  if (!textarea.clientWidth && !textarea.clientHeight) {
    return { top: 0, left: 0, lineHeight };
  }

  const mirror = document.createElement('div');
  mirror.style.position = 'fixed';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.top = '-9999px';
  mirror.style.left = '-9999px';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';

  for (const prop of MIRROR_PROPS) {
    mirror.style[prop] = computed[prop];
  }

  const clamped = Math.max(0, Math.min(position, textarea.value.length));
  mirror.textContent = textarea.value.slice(0, clamped);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const top = marker.offsetTop - textarea.scrollTop;
  const left = marker.offsetLeft - textarea.scrollLeft;
  document.body.removeChild(mirror);

  return {
    top: Number.isFinite(top) ? top : 0,
    left: Number.isFinite(left) ? left : 0,
    lineHeight,
  };
}
