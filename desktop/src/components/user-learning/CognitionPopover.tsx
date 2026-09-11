// Trylo — CognitionPopover（§4.3 轻浮层）。
// 点击角标展开；单屏优先、宽 ≤320px。选项一键回答 + 折叠的"用你的话回答" +
// 迷你动作行（记下 / 现在不 / 稍后 / 别再问类似问题）。非模态：不抢焦点。

import { type ReactElement, useState } from 'react';

export interface CognitionPopoverProps {
  readonly prompt: string;
  readonly options: readonly string[];
  readonly onAnswer: (text: string) => void;
  readonly onDismiss: (kind: 'not_now' | 'snooze' | 'dont_ask_similar') => void;
}

export function CognitionPopover(props: CognitionPopoverProps): ReactElement {
  const [text, setText] = useState('');
  const [revealInput, setRevealInput] = useState(false);
  const save = (): void => {
    if (!text.trim()) return;
    props.onAnswer(text.trim());
  };

  return (
    <div className="cognition-popover" role="dialog" aria-label="偏好问题">
      <p className="cognition-popover__prompt">{props.prompt}</p>
      {props.options.length > 0 ? (
        <div className="cognition-popover__options">
          {props.options.map((option) => (
            <button
              key={option}
              type="button"
              className="cognition-popover__option"
              onClick={() => props.onAnswer(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {revealInput ? (
        <textarea
          className="cognition-popover__input"
          value={text}
          rows={3}
          autoFocus
          placeholder="用你的话回答即可"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
          }}
        />
      ) : (
        <button type="button" className="cognition-popover__link" onClick={() => setRevealInput(true)}>
          用你的话回答
        </button>
      )}
      <footer className="cognition-popover__actions">
        {revealInput ? (
          <button type="button" className="cognition-popover__primary" disabled={!text.trim()} onClick={save}>
            记下
          </button>
        ) : null}
        <button type="button" className="cognition-popover__ghost" onClick={() => props.onDismiss('not_now')}>现在不</button>
        <button type="button" className="cognition-popover__ghost" onClick={() => props.onDismiss('snooze')}>稍后</button>
        <button type="button" className="cognition-popover__ghost" onClick={() => props.onDismiss('dont_ask_similar')}>别再问类似</button>
      </footer>
    </div>
  );
}