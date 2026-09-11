// Trylo — CognitionBadge（§4.2 角标 + §4.3 轻浮层）。
// 聊天面板容器右下角、InputBar 上方的绝对定位小药丸。默认收起，点击展开
// 轻浮层；出现时一次性轻微 pulse；无声音、无 toast；`aria-live="polite"`。
//
// README：本组件不用 portal——ContextRing 记载 popover/portal 曾被裁剪反复
// 出问题，本设计冻结"inline 定位"约束（位置由 .cognition-badge 绝对定位承载）。

import { type ReactElement, useEffect, useRef, useState } from 'react';
import type { PolicyDimension } from '../../user-learning/types';
import { dimensionLabel } from '../../user-learning/labels';
import { CognitionPopover } from './CognitionPopover';

export interface CognitionBadgeProps {
  readonly dimension: PolicyDimension;
  /** 出现的完整文案，如："有 1 个偏好问题待确认"。 */
  readonly label: string;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly onAnswer: (text: string) => void;
  readonly onDismiss: (kind: 'not_now' | 'snooze' | 'dont_ask_similar') => void;
  /** 每次用户发送下一条消息自增；变化时收起浮层但**保留角标**（§4.3）。 */
  readonly sendTick: number;
}

export function CognitionBadge(props: CognitionBadgeProps): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastTick = useRef(props.sendTick);

  // §4.3: 用户发送下一条消息 → 收起浮层，角标保留。收起 ≠ 处置，不写冷却。
  useEffect(() => {
    if (props.sendTick !== lastTick.current) {
      lastTick.current = props.sendTick;
      setOpen(false);
    }
  }, [props.sendTick]);

  // 外部点击 / Esc 收起。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="cognition-badge" ref={rootRef}>
      <button
        type="button"
        className={`cognition-badge__pill${open ? ' cognition-badge__pill--open' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-live="polite"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cognition-badge__dot" aria-hidden="true" />
        <span className="cognition-badge__label">{props.label}</span>
        <span className="cognition-badge__dim">{dimensionLabel(props.dimension)}</span>
      </button>
      {open ? (
        <CognitionPopover
          prompt={props.prompt}
          options={props.options}
          onAnswer={(text) => props.onAnswer(text)}
          onDismiss={(kind) => props.onDismiss(kind)}
        />
      ) : null}
    </div>
  );
}