import { type ReactElement } from 'react';
import type { LearningImpactMessage } from '../chat/types';

export interface LearningImpactCardProps {
  readonly message: LearningImpactMessage;
  readonly onResolve?: (id: string, acceptPersonalization: boolean) => void;
}

export function LearningImpactCard(props: LearningImpactCardProps): ReactElement {
  const { message } = props;
  const pending = message.status === 'pending';
  const canResolve = Boolean(props.onResolve);
  return (
    <article className={`cognition-card cognition-card--impact${pending ? '' : ` cognition-card--${message.status}`}`}>
      <header className="cognition-card__head">
        <span className="cognition-card__kicker">Preference Impact</span>
        <span className="cognition-card__state">
          {pending ? '需要确认' : message.status === 'accepted' ? '采用个性化' : '保留工程底线'}
        </span>
      </header>
      <p className="cognition-card__prompt">{message.reason}</p>
      <div className="cognition-card__compare">
        <div>
          <h4>工程基线</h4>
          <ul>{message.baseline.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
        <div>
          <h4>个性化后</h4>
          <ul>{message.personalized.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      </div>
      {pending ? (
        <footer className="cognition-card__actions">
          <button
            type="button"
            className="cognition-card__ghost"
            disabled={!canResolve}
            onClick={() => props.onResolve?.(message.id, false)}
          >
            保留工程基线
          </button>
          <button
            type="button"
            className="cognition-card__primary"
            disabled={!canResolve}
            onClick={() => props.onResolve?.(message.id, true)}
          >
            按我的偏好
          </button>
        </footer>
      ) : null}
    </article>
  );
}
