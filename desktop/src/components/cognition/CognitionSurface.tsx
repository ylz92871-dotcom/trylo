// Trylo Desktop — User Cognition fifth mode as a constrained chat.
// No tools, no Code/Work run. Answers become Evidence silently.

import { useMemo, useState, type ReactElement } from 'react';
import type { CognitionSession, UserLearningSnapshot } from '../../user-learning/types';
import { CognitionHistoryPanel } from './CognitionHistoryPanel';
import { sessionMessages } from '../../user-learning/cognition-skill/interviewer';

export interface CognitionSurfaceProps {
  readonly session: CognitionSession;
  readonly snapshot: UserLearningSnapshot;
  readonly busy?: boolean;
  readonly onSend: (text: string) => void;
  readonly onStop: (kind: 'dismiss' | 'snooze' | 'dont_ask_similar') => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onBack: () => void;
}

const STOP_LABELS: ReadonlyArray<{ kind: 'dismiss' | 'snooze' | 'dont_ask_similar'; label: string }> = [
  { kind: 'dismiss', label: '现在不' },
  { kind: 'snooze', label: '稍后' },
  { kind: 'dont_ask_similar', label: '别再问类似问题' },
];

export function CognitionSurface(props: CognitionSurfaceProps): ReactElement {
  const { session } = props;
  const [text, setText] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const turns = sessionMessages(session);
  const statusLabel = useMemo(() => {
    switch (session.status) {
      case 'open': return '进行中';
      case 'resolved': return '已结束';
      case 'dismissed': return '已跳过';
      case 'snoozed': return '稍后再聊';
      default: return session.status;
    }
  }, [session]);

  const send = (): void => {
    const value = text.trim();
    if (!value || props.busy || session.status !== 'open') return;
    setText('');
    props.onSend(value);
  };

  return (
    <div className={`cognition-surface${session.status !== 'open' ? ' cognition-surface--done' : ''}`}>
      <header className="cognition-surface__header">
        <div className="cognition-surface__title">
          <span className="cognition-surface__kicker">了解你怎么工作</span>
          <span className="cognition-surface__state">{statusLabel}</span>
        </div>
        <div className="cognition-surface__actions">
          <button
            type="button"
            className="cognition-surface__ghost"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
          >
            以往对话
          </button>
          <button
            type="button"
            className="cognition-surface__primary cognition-surface__back"
            onClick={props.onBack}
          >
            返回原任务
          </button>
        </div>
      </header>

      {showHistory ? (
        <CognitionHistoryPanel
          sessions={props.snapshot.cognitionSessions.filter((s) => s.trigger !== 'team_clarification')}
          activeSessionId={session.id}
          onOpenSession={props.onOpenSession}
        />
      ) : null}

      <div className="cognition-surface__thread" role="log" aria-label="认知对话">
        {turns.map((turn, i) => (
          <div
            className={`cognition-turn${turn.role === 'user' ? ' cognition-turn--answered' : ''}`}
            key={`${turn.role}-${turn.at}-${i}`}
          >
            <div className={`cognition-bubble cognition-bubble--${turn.role === 'user' ? 'answer' : 'question'}`}>
              <span className="cognition-bubble__tag">{turn.role === 'user' ? '我' : 'Trylo'}</span>
              <p>{turn.text}</p>
            </div>
          </div>
        ))}
        {props.busy ? (
          <div className="cognition-turn">
            <div className="cognition-bubble cognition-bubble--question">
              <span className="cognition-bubble__tag">Trylo</span>
              <p>……</p>
            </div>
          </div>
        ) : null}
      </div>

      {session.status === 'open' ? (
        <div className="cognition-ask">
          <textarea
            className="cognition-ask__input"
            value={text}
            rows={2}
            placeholder="直接说你的习惯，例如：做 PPT 先出一版再改，电脑低风险你自己点。"
            disabled={props.busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="cognition-ask__actions">
            <button
              type="button"
              className="cognition-surface__primary"
              disabled={!text.trim() || props.busy}
              onClick={send}
            >
              发送
            </button>
            <button
              type="button"
              className="cognition-surface__ghost"
              disabled={props.busy}
              onClick={() => props.onSend('先这样')}
            >
              先这样
            </button>
            {STOP_LABELS.map((s) => (
              <button key={s.kind} type="button" className="cognition-surface__ghost" onClick={() => props.onStop(s.kind)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="cognition-surface__end">
          <p>{session.recap ?? '这轮先停在这里。之后你在真实任务里纠正我，我也会慢慢学。'}</p>
          <button type="button" className="cognition-surface__primary" onClick={props.onBack}>返回原任务</button>
        </div>
      )}
    </div>
  );
}
