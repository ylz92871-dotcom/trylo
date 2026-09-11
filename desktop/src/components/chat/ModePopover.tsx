// Trylo Desktop — ModePopover.
//
// v1.7: clicking the + in the InputBar opens this listbox
// with the three code sub-modes. Click outside or press
// Escape to close. Arrow keys + Enter for keyboard nav.
//
// Bug fix v1.7.1: the document mousedown listener was
// registered in a useEffect with `props` in the deps. Since
// `props` is a new object on every parent render, the
// effect re-ran on every render — removing and re-adding
// the listener. In some race conditions this caused the
// popover to close before the click on a list item could
// fire. The fix: depend only on the stable `onClose`
// callback, and bind the click handler once via React.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { CodeMode } from '../../host-adapter/types';

const MODES: readonly { readonly value: CodeMode; readonly label: string; readonly hint: string }[] = [
  { value: 'chat',      label: 'Chat',      hint: 'Ask anything' },
  { value: 'plan',      label: 'Plan',      hint: 'Design first' },
  { value: 'agent',     label: 'Agent',     hint: 'Build + test' },
  { value: 'cognition', label: 'Cognition', hint: 'Talk about how you work' },
];

export interface ModePopoverProps {
  readonly current: CodeMode;
  readonly onSelect: (mode: CodeMode) => void;
  readonly onClose: () => void;
  readonly anchorRef: React.RefObject<HTMLElement | null>;
}

export function ModePopover(props: ModePopoverProps): ReactElement {
  const [focusIndex, setFocusIndex] = useState(() =>
    Math.max(0, MODES.findIndex((m) => m.value === props.current)),
  );
  const listRef = useRef<HTMLUListElement>(null);

  // Capture the latest onSelect/onClose in refs so the
  // listeners below don't have to re-bind on every render.
  // The mousedown + keydown handlers are stable.
  const onSelectRef = useRef(props.onSelect);
  const onCloseRef = useRef(props.onClose);
  onSelectRef.current = props.onSelect;
  onCloseRef.current = props.onClose;

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (!t) return;
      if (props.anchorRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIndex((i) => (i + 1) % MODES.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIndex((i) => (i - 1 + MODES.length) % MODES.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const m = MODES[focusIndex];
        if (m) {
          onSelectRef.current(m.value);
          onCloseRef.current();
        }
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // anchorRef is a stable ref; focusIndex is captured in onKey closure

  return (
    <ul
      ref={listRef}
      className="mode-popover"
      role="listbox"
      aria-label="Code sub-mode"
      tabIndex={-1}
    >
      {MODES.map((m, i) => {
        const active = i === focusIndex;
        const current = m.value === props.current;
        return (
          <li
            key={m.value}
            role="option"
            aria-selected={current}
            className={`mode-popover__item${active ? ' mode-popover__item--focus' : ''}${current ? ' mode-popover__item--current' : ''}`}
            onMouseEnter={() => setFocusIndex(i)}
            onClick={() => {
              onSelectRef.current(m.value);
              onCloseRef.current();
            }}
          >
            <span className="mode-popover__label">{m.label}</span>
            <span className="mode-popover__hint">{m.hint}</span>
          </li>
        );
      })}
    </ul>
  );
}
