import { type ReactElement, useState } from 'react';
import type { CognitionPromptMessage } from '../chat/types';

export interface CognitionPromptCardProps {
  readonly message: CognitionPromptMessage;
  readonly onAnswer?: (id: string, text: string) => void;
  readonly onDismiss?: (id: string, kind: 'dismiss' | 'not_now' | 'snooze' | 'dont_ask_similar') => void;
}

export function CognitionPromptCard(props: CognitionPromptCardProps): ReactElement {
  const { message } = props;
  const [text, setText] = useState('');
  const pending = message.status === 'pending';
  const canAnswer = Boolean(props.onAnswer);
  const canDismiss = Boolean(props.onDismiss);

  return (
    <article className={`cognition-card${pending ? '' : ` cognition-card--${message.status}`}`}>
      <header className="cognition-card__head">
        <span className="cognition-card__kicker">想确认一下</span>
        <span className="cognition-card__state">
          {pending ? '等待回答' : message.status === 'answered' ? '已记下' : '已跳过'}
        </span>
      </header>
      <p className="cognition-card__prompt">{message.prompt}</p>
      {pending && message.options.length > 0 ? (
        <div className="cognition-card__options">
          {message.options.map((option) => (
            <button
              key={option}
              type="button"
              className="cognition-card__option"
              disabled={!canAnswer}
              onClick={() => props.onAnswer?.(message.id, option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {pending ? (
        <>
          <textarea
            className="cognition-card__input"
            value={text}
            rows={2}
            placeholder="用你的话回答即可"
            onChange={(e) => setText(e.target.value)}
          />
          <footer className="cognition-card__actions">
            <button type="button" className="cognition-card__ghost" disabled={!canDismiss} onClick={() => props.onDismiss?.(message.id, 'not_now')}>现在不</button>
            <button type="button" className="cognition-card__ghost" disabled={!canDismiss} onClick={() => props.onDismiss?.(message.id, 'snooze')}>稍后</button>
            <button type="button" className="cognition-card__ghost" disabled={!canDismiss} onClick={() => props.onDismiss?.(message.id, 'dont_ask_similar')}>别再问类似问题</button>
            <button
              type="button"
              className="cognition-card__primary"
              disabled={!canAnswer || !text.trim()}
              onClick={() => props.onAnswer?.(message.id, text.trim())}
            >
              记下
            </button>
          </footer>
        </>
      ) : null}
    </article>
  );
}
