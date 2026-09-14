// Trylo Desktop — ModeChip. See v1.16.1.
//
// v1.16.1: a color-coded chip in the chat panel that
// shows the active code sub-mode (Plan / Agent / Chat).
// Replaces the "hidden in the + button" mode switcher:
// the chip is always visible so the user knows what
// mode they're in, and clicking it opens the existing
// ModePopover to switch.
//
// In PLAN mode a small "Apply plan → Switch to Agent"
// button sits to the right of the chip. Clicking it
// switches codeMode to 'agent' — the user can then
// re-engage the agent to implement the plan. The
// desktop does NOT auto-send ("implement it") because
// the user should review the plan first; this is the
// mature-IDE pattern (Cline's Plan/Act toggle, Cursor
// plan mode).
//
// Read old code at:
//   - C:/work/demo-ws/trylo cli/src/commands/compact/compact.ts
//     (CLI plan mode is --permission-mode plan; toolsForMode
//     in settings-store.ts disables built-in tools)
//   - extension.js:3084-3100 (buildPlanImplementationContext:
//     the OLD code's plan → agent transition, which we
//     intentionally do NOT replicate — the conversation IS
//     the plan, no artifact parsing needed in the new CLI)
// Reuses: ModePopover (existing), settings-store (the mode
// already maps to CLI spawn args).
// Do NOT: auto-send "implement" without user review.

import { useRef, useState, type ReactElement } from 'react';
import type { CodeMode } from '../../host-adapter/types';
import { ModePopover } from './ModePopover';

export interface ModeChipProps {
  readonly current: CodeMode;
  readonly onChange: (mode: CodeMode) => void;
  /** v1.16.1: switch to 'agent' and clear the input —
   *  user can then re-engage the agent to implement.
   *  Only meaningful when in plan mode. */
  readonly onApplyPlan: () => void;
}

const MODE_META: Readonly<
  Record<CodeMode, { readonly label: string; readonly hint: string; readonly icon: string }>
> = {
  chat:      { label: 'Chat',      hint: 'Ask anything',           icon: '💬' },
  plan:      { label: 'Plan',      hint: 'Read-only — analyze',   icon: '📐' },
  agent:     { label: 'Agent',     hint: 'Build + test',           icon: '⚡' },
  cognition: { label: 'Cognition', hint: 'Talk about how you work', icon: '◈' },
};

export function ModeChip(props: ModeChipProps): ReactElement {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="mode-chip-row">
      <button
        ref={anchorRef}
        type="button"
        className={`mode-chip mode-chip--${props.current}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Current mode: ${MODE_META[props.current].label}. Click to switch.`}
      >
        <span className="mode-chip__icon" aria-hidden="true">
          {MODE_META[props.current].icon}
        </span>
        <span className="mode-chip__label">{MODE_META[props.current].label}</span>
        <span className="mode-chip__hint">{MODE_META[props.current].hint}</span>
        <span className="mode-chip__caret" aria-hidden="true">▾</span>
      </button>
      {props.current === 'plan' && (
        <button
          type="button"
          className="mode-chip__apply"
          onClick={props.onApplyPlan}
          title="Switch to Agent mode so the agent can implement the plan"
        >
          <span className="mode-chip__apply-icon" aria-hidden="true">↪</span>
          Apply plan
        </button>
      )}
      {open && (
        <ModePopover
          current={props.current}
          onSelect={(m) => {
            props.onChange(m);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
        />
      )}
    </div>
  );
}
