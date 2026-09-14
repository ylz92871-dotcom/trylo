import { type ReactElement, useEffect, useRef, useState } from 'react';
import type { LearningReceipt } from '../../user-learning/types';
import { LearningReceiptPopover } from './LearningReceiptPopover';

export interface LearningReceiptPillProps {
  readonly receipt: LearningReceipt;
  readonly canActivate: boolean;
  readonly onAcknowledge: () => void;
  readonly onActivate: () => void;
  readonly onThisTimeOnly: () => void;
  readonly onChangeScope: (scope: 'project' | 'product') => void;
  readonly onPause: () => void;
  readonly onRetract: () => void;
  readonly autoCollapseMs?: number;
}

export function LearningReceiptPill(props: LearningReceiptPillProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const acknowledgeRef = useRef(props.onAcknowledge);
  acknowledgeRef.current = props.onAcknowledge;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setOpen(false);
      setVisible(false);
      acknowledgeRef.current();
    }, props.autoCollapseMs ?? 8_000);
    return () => window.clearTimeout(timer);
  }, [props.receipt.id, props.autoCollapseMs]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  if (!visible) return null;
  return (
    <div className="learning-receipt" ref={rootRef}>
      <button
        type="button"
        className={`learning-receipt__pill${open ? ' learning-receipt__pill--open' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-live="polite"
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">✓</span>
        <span>{props.receipt.message}</span>
      </button>
      {open ? <LearningReceiptPopover {...props} /> : null}
    </div>
  );
}
