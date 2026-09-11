import { type ReactElement } from 'react';
import type { EnforcementMode } from '../../user-learning/types';

export interface LearningStatusChipProps {
  readonly mode: EnforcementMode;
  readonly evidenceCount: number;
  readonly modelCount: number;
  readonly injected: boolean;
  readonly onOpen: () => void;
}

export function LearningStatusChip(props: LearningStatusChipProps): ReactElement {
  const label = props.mode === 'enforced'
    ? (props.injected ? 'Learning · 已注入' : 'Learning · Enforced')
    : props.mode === 'off'
      ? 'Learning · Off'
      : 'Learning · Shadow';
  return (
    <button
      type="button"
      className={`learning-chip learning-chip--${props.mode}${props.injected ? ' is-injected' : ''}`}
      onClick={props.onOpen}
      aria-label={`User Learning ${props.mode}, Evidence ${props.evidenceCount}`}
      title={`Evidence ${props.evidenceCount} · User Model ${props.modelCount}`}
    >
      <span className="learning-chip__dot" aria-hidden="true" />
      <span className="learning-chip__label">{label}</span>
      <span className="learning-chip__count">{props.evidenceCount}</span>
    </button>
  );
}
