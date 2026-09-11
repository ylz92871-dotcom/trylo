import type { ReactElement } from 'react';
import type { CollaborationSurface } from './types';

export interface CollaborationSwitchProps {
  readonly value: CollaborationSurface;
  readonly onChange: (value: CollaborationSurface) => void;
  /** Pass through to disable the switch in App-level loading / error
   *  states. Default false. */
  readonly disabled?: boolean;
}

/**
 * The right-side switch in TopBar. Spec §1.2: it is its own tablist
 * (separate from the Code/Work tablist). Visual weight must stay below
 * the Code/Work tablist so it does not read as a third product mode.
 *
 * Implementation: a self-sized pill, two text-only options. No icons
 * (icons push the weight up). Active option uses brand-soft fill +
 * brand edge, same family as the Code/Work tabs but smaller.
 */
export function CollaborationSwitch(props: CollaborationSwitchProps): ReactElement {
  const { value, onChange, disabled = false } = props;
  return (
    <div
      className="collaboration-switch"
      role="tablist"
      aria-label="协作表面"
    >
      <button
        type="button"
        role="tab"
        aria-selected={value === 'person'}
        aria-current={value === 'person' ? 'page' : undefined}
        className={`collaboration-switch__option${value === 'person' ? ' collaboration-switch__option--active' : ''}`}
        onClick={() => onChange('person')}
        disabled={disabled}
        title="对话：和 Trylo 说话"
      >
        对话
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'team'}
        aria-current={value === 'team' ? 'page' : undefined}
        className={`collaboration-switch__option${value === 'team' ? ' collaboration-switch__option--active' : ''}`}
        onClick={() => onChange('team')}
        disabled={disabled}
        title="团队：看谁在做、点开过程"
      >
        团队
      </button>
    </div>
  );
}
