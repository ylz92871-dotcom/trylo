// Trylo Desktop — Remote pairing modal.
//
// 2026-08-29: the pairing QR used to live *inside* the
// Settings modal's Remote group — you had to open
// Settings, find the Remote section, and click "显示配对
// 二维码" to pair a phone. That is three clicks of
// discoverability debt. The remote quick-toggle already
// moved to the TopBar (see TopBar.tsx), so the QR belongs
// right next to it: clicking the TopBar "远程" button
// opens THIS modal. One click from the bar → QR in front
// of you.
//
// The modal is the single home for on-demand pairing now:
//   * shows the live gateway state (running / enabled /
//     disabled) from `remoteStatus`,
//   * an enable/disable switch (reuses the same
//     `onRemoteToggle` as the TopBar button, so the two
//     never diverge),
//   * the pairing QR, auto-generated when the gateway is
//     enabled and refreshable on demand.
// Settings keeps only the *configuration* (port / tunnel /
// URL) — no more QR button there.

import { useEffect, useState, type ReactElement, type FormEvent } from 'react';
import { RadioTower, RefreshCw, X } from 'lucide-react';
import type {
  RemotePairingInfoResult,
  RemoteStatusResult,
} from '../../services-host/methods';

export interface RemotePairingModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Live gateway state (spec §8.1.4). Absent = unknown. */
  readonly remoteStatus?: RemoteStatusResult | null;
  /** Surface for on-demand pairing (QR). Absent = not wired. */
  readonly remoteController?: { pairing(): Promise<RemotePairingInfoResult> } | null;
  /** Whether remote access is currently enabled. */
  readonly remoteEnabled?: boolean;
  /** Flip remote access on/off (same handler as the TopBar toggle). */
  readonly onRemoteToggle?: () => void;
}

export function RemotePairingModal(props: RemotePairingModalProps): ReactElement | null {
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const enabled = props.remoteEnabled ?? false;
  const status = props.remoteStatus;
  const running = status?.running ?? false;

  // Reset transient pairing state whenever the modal closes
  // or the gateway is turned off.
  useEffect(() => {
    if (!props.open || !enabled) {
      setQr(null);
      setError(null);
      setLoading(false);
    }
  }, [props.open, enabled]);

  // Auto-generate the QR as soon as the modal is open AND
  // the gateway is enabled. When the user flips the switch
  // on from inside the modal, `enabled` flips → this effect
  // re-runs and generates the QR without a second click.
  useEffect(() => {
    if (!props.open || !enabled || props.remoteController == null) return;
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, enabled, props.remoteController]);

  const generate = (): void => {
    if (props.remoteController == null) return;
    setError(null);
    setLoading(true);
    void props.remoteController.pairing()
      .then((info) => setQr(info.qrDataUrl))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  if (!props.open) return null;

  const headline = !enabled
    ? '远程访问已关闭'
    : running
      ? '远程访问运行中'
      : '远程访问已启用（等待启动）';

  const statusTone = !enabled
    ? 'remote-pairing-modal__status--off'
    : running
      ? 'remote-pairing-modal__status--ok'
      : 'remote-pairing-modal__status--pending';

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    props.onClose();
  };

  return (
    <div
      className="remote-pairing-modal__overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        className="remote-pairing-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-pairing-modal__title"
      >
        <header className="remote-pairing-modal__header">
          <span className="remote-pairing-modal__title-wrap">
            <RadioTower size={16} strokeWidth={2} aria-hidden="true" />
            <h2
              id="remote-pairing-modal__title"
              className="remote-pairing-modal__title"
            >
              远程访问
            </h2>
          </span>
          <button
            type="button"
            className="remote-pairing-modal__close"
            onClick={props.onClose}
            aria-label="关闭"
            title="关闭"
          >
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>

        <div className={`remote-pairing-modal__status ${statusTone}`} role="status" aria-live="polite">
          <span className="remote-pairing-modal__status-dot" aria-hidden="true" />
          <span className="remote-pairing-modal__status-headline">{headline}</span>
          {status?.publicUrl ? (
            <span className="remote-pairing-modal__hint">
              公网地址: <code>{status.publicUrl}</code>
            </span>
          ) : null}
          {status?.port ? (
            <span className="remote-pairing-modal__hint">
              端口: <code>{status.port}</code>
            </span>
          ) : null}
        </div>

        {/* Enable / disable switch — the same handler the
            TopBar toggle uses, so state stays in one place. */}
        <label className="remote-pairing-modal__switch">
          <input
            type="checkbox"
            checked={enabled}
            onChange={() => props.onRemoteToggle?.()}
          />
          <span className="remote-pairing-modal__switch-label">
            启用远程访问（手机扫码连接本机 Code 会话）
          </span>
        </label>

        <div className="remote-pairing-modal__body">
          {!enabled ? (
            <p className="remote-pairing-modal__empty">
              开启后即可用手机 Trylo App 扫码连接。开启后二维码会自动出现在这里。
            </p>
          ) : (
            <>
              <div className="remote-pairing-modal__qr-wrap">
                {loading && !qr ? (
                  <div className="remote-pairing-modal__qr-skeleton" aria-hidden="true" />
                ) : qr ? (
                  <img
                    className="remote-pairing-modal__qr"
                    src={qr}
                    alt="配对二维码 — 用手机扫码连接"
                  />
                ) : (
                  <div className="remote-pairing-modal__qr-skeleton" aria-hidden="true" />
                )}
              </div>
              <p className="remote-pairing-modal__hint remote-pairing-modal__hint--center">
                用手机 Trylo App 扫码，即可在本机与其他设备间共享 Code 会话。
              </p>
              <button
                type="button"
                className="remote-pairing-modal__btn"
                onClick={generate}
                disabled={loading}
              >
                <RefreshCw
                  size={14}
                  strokeWidth={2}
                  aria-hidden="true"
                  className={loading ? 'remote-pairing-modal__spin' : undefined}
                />
                {loading ? '生成中…' : qr ? '刷新配对二维码' : '生成配对二维码'}
              </button>
              {error ? (
                <span className="remote-pairing-modal__hint remote-pairing-modal__hint--error">
                  {error}
                </span>
              ) : null}
            </>
          )}
        </div>

        <footer className="remote-pairing-modal__footer">
          <button type="button" className="remote-pairing-modal__btn--ghost" onClick={onSubmit}>
            完成
          </button>
        </footer>
      </div>
    </div>
  );
}
