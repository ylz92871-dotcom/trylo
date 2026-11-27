import { useEffect, useRef, useState, type ReactElement } from 'react';
import { prefersReducedMotion } from '../../utils/use-presence-transition';

export interface PartialTextTransitionProps {
  readonly value: string | number;
  readonly className?: string;
  readonly numeric?: boolean;
  readonly dragRegion?: string;
}

function isJsdom(): boolean {
  return typeof navigator === 'undefined' || /\bjsdom\b/i.test(navigator.userAgent);
}

/**
 * Transitions only the changing token/number in place while keeping surrounding copy stable.
 * Previous values are marked aria-hidden so assistive technology reads only the latest state.
 */
export function PartialTextTransition(props: PartialTextTransitionProps): ReactElement {
  const nextText = String(props.value);
  const currentRef = useRef(nextText);
  const [exitingText, setExitingText] = useState<string | null>(null);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    const prev = currentRef.current;
    if (prev === nextText) return;
    currentRef.current = nextText;

    if (prefersReducedMotion() || isJsdom()) {
      setExitingText(null);
      setAnimating(false);
      return;
    }

    setExitingText(prev);
    setAnimating(true);
    const timer = window.setTimeout(() => {
      setExitingText(null);
      setAnimating(false);
    }, 170);

    return () => window.clearTimeout(timer);
  }, [nextText]);

  const cls = [
    'partial-text',
    props.numeric ? 'partial-text--numeric' : '',
    animating ? 'partial-text--animating' : '',
    props.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={cls}>
      {exitingText !== null && (
        <span key={`out:${exitingText}`} className="partial-text__exit" aria-hidden="true">
          {exitingText}
        </span>
      )}
      <span
        key={`in:${nextText}`}
        className="partial-text__current"
        {...(props.dragRegion !== undefined ? { 'data-tauri-drag-region': props.dragRegion } : {})}
      >
        {nextText}
      </span>
    </span>
  );
}
