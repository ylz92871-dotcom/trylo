import { useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import {
  dismissToast,
  pauseToast,
  resumeToast,
  useToasts,
  type ToastItem,
  type ToastTone,
} from './toast-store';

const TONE_ICON: Readonly<Record<ToastTone, typeof Info>> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
};

function ToastRow(props: { readonly item: ToastItem }): ReactElement {
  const { item } = props;
  const [busy, setBusy] = useState(false);
  const Icon = TONE_ICON[item.tone];

  const handleAction = async (): Promise<void> => {
    if (!item.action || busy) return;
    setBusy(true);
    try {
      await item.action.onAction();
      dismissToast(item.id);
    } catch {
      setBusy(false);
    }
  };

  return (
    <div
      className={`toast-item toast-item--${item.tone}`}
      role={item.tone === 'error' ? 'alert' : 'status'}
      aria-live={item.tone === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => pauseToast(item.id)}
      onMouseLeave={() => resumeToast(item.id)}
      onFocus={() => pauseToast(item.id)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          resumeToast(item.id);
        }
      }}
    >
      <span className="toast-item__icon" aria-hidden="true">
        <Icon size={16} strokeWidth={1.8} />
      </span>
      <div className="toast-item__body">
        <div className="toast-item__title">{item.title}</div>
        {item.detail && <div className="toast-item__detail">{item.detail}</div>}
      </div>
      {item.action && (
        <button
          type="button"
          className="toast-item__action"
          disabled={busy}
          onClick={() => void handleAction()}
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-item__close"
        aria-label={`关闭通知：${item.title}`}
        title="关闭"
        onClick={() => dismissToast(item.id)}
      >
        <X size={14} strokeWidth={1.9} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Shared portal toast host. Never steals focus from active inputs.
 */
export function ToastHost(): ReactElement | null {
  const toasts = useToasts();
  if (toasts.length === 0 || typeof document === 'undefined') return null;

  return createPortal(
    <div className="toast-host" aria-label="通知">
      {toasts.map((item) => (
        <ToastRow key={item.id} item={item} />
      ))}
    </div>,
    document.body,
  );
}
