// Trylo Desktop — User Cognition history list.
//
// Shows past / in-progress cognition sessions so the user can reopen a
// thread like a conversation. Reading / reopening a resolved session just
// shows its transcript; answers are immutable once recorded.

import type { ReactElement } from 'react';
import type { CognitionSession } from '../../user-learning/types';
import { dimensionLabel } from '../../user-learning/labels';
import { sessionMessages } from '../../user-learning/cognition-skill/interviewer';

export interface CognitionHistoryPanelProps {
  readonly sessions: readonly CognitionSession[];
  readonly activeSessionId: string;
  readonly onOpenSession: (sessionId: string) => void;
}

const STATUS_TEXT: Record<CognitionSession['status'], string> = {
  open: '进行中',
  resolved: '已结束',
  dismissed: '已跳过',
  snoozed: '稍后再聊',
};

function historyTitle(session: CognitionSession): string {
  const userTurn = sessionMessages(session).find((m) => m.role === 'user');
  if (userTurn?.text.trim()) return userTurn.text.trim().slice(0, 36);
  return dimensionLabel(session.dimension);
}

export function CognitionHistoryPanel(props: CognitionHistoryPanelProps): ReactElement {
  const history = [...props.sessions].reverse();
  return (
    <aside className="cognition-history" aria-label="认知历史">
      <p className="cognition-history__hint">以往关于「你怎么工作」的对话</p>
      {history.length === 0 ? (
        <p className="cognition-history__empty">还没有认知会话。</p>
      ) : (
        <ul className="cognition-history__list">
          {history.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={`cognition-history__item${s.id === props.activeSessionId ? ' is-active' : ''}`}
                onClick={() => props.onOpenSession(s.id)}
              >
                <span className="cognition-history__dim">{historyTitle(s)}</span>
                <span className="cognition-history__meta">
                  {STATUS_TEXT[s.status]} · {dimensionLabel(s.dimension)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}