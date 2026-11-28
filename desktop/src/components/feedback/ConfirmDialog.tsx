import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { usePresenceTransition } from '../../utils/use-presence-transition';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly tone?: 'danger' | 'default';
  readonly onConfirm: () => void | Promise<void>;
  readonly onCancel: () => void;
}

/**
 * Accessible confirmation modal.
 * Focus starts on Cancel so destructive confirmations cannot be triggered by an accidental Enter.
 */
export function ConfirmDialog(props: ConfirmDialogProps): ReactElement | null {
  const {
    open,
    title,
    description,
    confirmLabel = '确认',
    cancelLabel = '取消',
    tone = 'default',
    onConfirm,
    onCancel,
  } = props;
  const titleId = useId();
  const descId = useId();
  const presence = usePresenceTransition(open, 130);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      return;
    }

    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex]:not([tabindex="-1"])')];
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
      openerRef.current = null;
    };
  }, [open]);

  if (!presence.mounted || typeof document === 'undefined') return null;

  const isExiting = presence.state === 'exiting';

  const handleConfirm = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="confirm-dialog__backdrop"
      data-motion-state={presence.state}
      aria-hidden={isExiting ? true : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className={`confirm-dialog confirm-dialog--${tone}`}
        role={isExiting ? undefined : 'dialog'}
        aria-modal={isExiting ? undefined : 'true'}
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <div className="confirm-dialog__header">
          {tone === 'danger' && (
            <span className="confirm-dialog__icon" aria-hidden="true">
              <AlertTriangle size={18} strokeWidth={1.8} />
            </span>
          )}
          <h2 id={titleId} className="confirm-dialog__title">{title}</h2>
        </div>
        <p id={descId} className="confirm-dialog__description">{description}</p>
        <div className="confirm-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--cancel"
            disabled={submitting}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-dialog__btn ${tone === 'danger' ? 'confirm-dialog__btn--danger' : 'confirm-dialog__btn--confirm'}`}
            disabled={submitting}
            onClick={() => void handleConfirm()}
          >
            {submitting ? '正在处理…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
