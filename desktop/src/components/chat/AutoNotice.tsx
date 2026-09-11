// Trylo Desktop — AutoNotice (non-blocking reminder for dont_ask).
//
// Spec: 完全自动模式下，中低风险仅提醒不卡住，特高风险才强阻塞。
// This component is PURE UI — never blocks the task. It shows a
// 3s countdown "将于 3s 后自动继续 · [暂停]" then flips to
// "已自动继续". User can click 暂停 to freeze it as a persistent
// hint. Styling reuses WorkActivityGroup / disclosure language:
// mono xs, 3px left accent, no modal, no spinner loop.

import { memo, useEffect, useRef, useState, type ReactElement } from 'react';

export type AutoNoticeTone = 'info' | 'warn';

export interface AutoNoticeProps {
  readonly id: string;
  readonly tone?: AutoNoticeTone;
  /** Short title, e.g. "已写入 .trylo/out/report.docx" */
  readonly title: string;
  /** Optional detail line, e.g. "原件不受影响 · 将于 3s 后自动继续" */
  readonly detail?: string;
  /** Auto-continue delay ms. 0 = no countdown, just a persistent hint. */
  readonly autoContinueMs?: number;
  readonly onPause?: () => void;
  readonly onAutoContinue?: () => void;
}

function AutoNoticeImpl(props: AutoNoticeProps): ReactElement {
  const tone = props.tone ?? 'info';
  const delay = props.autoContinueMs ?? 3000;
  const [paused, setPaused] = useState(false);
  const [continued, setContinued] = useState(delay === 0);
  const [remaining, setRemaining] = useState(Math.ceil(delay / 1000));
  const timerRef = useRef<number | null>(null);
  const onAutoContinueRef = useRef(props.onAutoContinue);
  onAutoContinueRef.current = props.onAutoContinue;

  useEffect(() => {
    if (delay === 0 || paused || continued) return;
    const startedAt = Date.now();
    const tick = (): void => {
      const left = delay - (Date.now() - startedAt);
      if (left <= 0) {
        setContinued(true);
        setRemaining(0);
        onAutoContinueRef.current?.();
        return;
      }
      setRemaining(Math.max(1, Math.ceil(left / 1000)));
      timerRef.current = window.setTimeout(tick, 200) as unknown as number;
    };
    timerRef.current = window.setTimeout(tick, 200) as unknown as number;
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [delay, paused, continued]);

  const handlePause = (): void => {
    setPaused(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    props.onPause?.();
  };

  return (
    <div
      className={`auto-notice auto-notice--${tone}${continued ? ' auto-notice--continued' : ''}${paused ? ' auto-notice--paused' : ''}`}
      role="status"
      aria-live="polite"
      data-notice-id={props.id}
    >
      <span className="auto-notice__title">{props.title}</span>
      {props.detail ? <span className="auto-notice__detail">{props.detail}</span> : null}
      {!continued && delay > 0 ? (
        <span className="auto-notice__countdown">
          {paused ? '已暂停' : `将于 ${remaining}s 后自动继续`}
          {!paused ? (
            <button type="button" className="auto-notice__pause" onClick={handlePause}>
              暂停
            </button>
          ) : null}
        </span>
      ) : continued && delay > 0 ? (
        <span className="auto-notice__continued">已自动继续</span>
      ) : null}
    </div>
  );
}

export const AutoNotice = memo(AutoNoticeImpl);
