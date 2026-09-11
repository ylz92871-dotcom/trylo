// Trylo Desktop — PermissionLevelPicker (P2, spec §3.2 / §7).
//
// A controlled, four-level permission chip shared by Code and Work
// composers. PURE UI — it does not read any runtime, does not know
// what `codeMode` is, does not write settings, does not decide
// whether the next run is in flight. The parent owns the effective
// level + the change handler; this component only renders and
// routes user input.
//
// Invariants:
//   - one chip on the action row, opens a 4-item menu;
//   - the chip's label comes from the controlled `level`, NOT from
//     anything the picker derives itself;
//   - `pendingNextTurn` makes the chip visually append "下轮生效"
//     without changing the controlled `level` value;
//   - full keyboard support (ArrowUp/Down, Home/End, Enter, Space,
//     Escape) + outside click + focus restore.
//
// The component is a button + listbox because the spec calls out
// the wrong-ARIA risk for menu vs listbox when a single selection
// is the only outcome.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import {
  Eye,
  ShieldAlert,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  PERMISSION_LEVELS,
  type PermissionLevel,
  type PermissionLevelDescriptor,
} from '../../permission/permission-policy';

const ICONS: Readonly<Record<PermissionLevel, LucideIcon>> = {
  read_only: Eye,
  ask: ShieldAlert,
  workspace_write: Wrench,
  unrestricted: ShieldCheck,
};

export interface PermissionLevelPickerProps {
  /** The currently-effective level (snapshot or live, parent's choice). */
  readonly level: PermissionLevel;
  /** Where the effective value came from. Used to show "当前会话"/"设置默认"
   *  in the menu. */
  readonly source: 'settings' | 'conversation';
  /** True when a run is in flight AND the next turn will use a
   *  different level. Renders "下轮生效" hint without changing the
   *  controlled `level`. */
  readonly pendingNextTurn?: boolean;
  /** Disable all interaction (e.g. while the daemon is reconnecting). */
  readonly disabled?: boolean;
  /** Called with the new level on user confirmation. The picker is
   *  controlled: the parent decides whether to apply it now or
   *  queue it for the next turn. */
  readonly onChange: (level: PermissionLevel) => void;
  /** Optional aria-label override; defaults to a stable string. */
  readonly ariaLabel?: string;
}

export function PermissionLevelPicker(
  props: PermissionLevelPickerProps,
): ReactElement {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState<number>(() =>
    Math.max(0, PERMISSION_LEVELS.findIndex((d) => d.value === props.level)),
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const labelId = useId();

  const current = describeLevel(props.level);
  const CurrentIcon = ICONS[props.level];

  const closeAndRestore = useCallback((): void => {
    setOpen(false);
    // restore focus to the trigger; matches the a11y contract the
    // Run-workflow picker established.
    triggerRef.current?.focus();
  }, []);

  const onTriggerKey = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>): void => {
      if (props.disabled) return;
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setFocusIndex(
          Math.max(0, PERMISSION_LEVELS.findIndex((d) => d.value === props.level)),
        );
        setOpen(true);
      }
    },
    [props.disabled, props.level],
  );

  // Document-level handlers while the menu is open. Bound once per
  // open transition (the deps do not include focusIndex; the keydown
  // handler reads it from a ref so a stale closure can never dismiss
  // a follow-up ArrowDown).
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIndex((i) => (i + 1) % PERMISSION_LEVELS.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIndex((i) => (i - 1 + PERMISSION_LEVELS.length) % PERMISSION_LEVELS.length);
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        setFocusIndex(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        setFocusIndex(PERMISSION_LEVELS.length - 1);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const choice = PERMISSION_LEVELS[focusIndexRef.current];
        if (choice) {
          props.onChange(choice.value);
          setOpen(false);
          triggerRef.current?.focus();
        }
      }
    };
    const focusIndexRef = { current: focusIndex };
    // Mirror focusIndex into a ref the document handler reads — keeps
    // the listener single-bound for the menu's lifetime.
    const mirror = (): void => {
      focusIndexRef.current = focusIndex;
    };
    // Force the ref to update on every render — a fresh closure each
    // render keeps the value live without re-binding the listener.
    mirror();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, focusIndex, props]);

  const onSelect = useCallback(
    (level: PermissionLevel): void => {
      props.onChange(level);
      closeAndRestore();
    },
    [props, closeAndRestore],
  );

  return (
    <div className="permission-picker">
      <button
        ref={triggerRef}
        type="button"
        className={
          'permission-picker__trigger'
          + (props.pendingNextTurn ? ' permission-picker__trigger--pending' : '')
          + (props.disabled ? ' permission-picker__trigger--disabled' : '')
          + ` permission-picker__trigger--${current.risk}`
        }
        onClick={() => {
          if (props.disabled) return;
          setOpen((v) => !v);
        }}
        onKeyDown={onTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? labelId : undefined}
        aria-label={
          props.ariaLabel
            ?? `Permission level: ${current.label}`
        }
        disabled={props.disabled}
      >
        <CurrentIcon size={14} strokeWidth={2} aria-hidden="true" />
        <span className="permission-picker__trigger-label">{current.label}</span>
        {props.pendingNextTurn ? (
          <span className="permission-picker__pending" aria-label="下轮生效">
            下轮生效
          </span>
        ) : null}
        <span aria-hidden="true" className="permission-picker__caret">▾</span>
      </button>
      {open ? (
        <ul
          ref={listRef}
          id={labelId}
          role="listbox"
          aria-label="选择权限等级"
          className="permission-picker__menu"
        >
          {PERMISSION_LEVELS.map((d, i) => {
            const Icon = ICONS[d.value];
            const isCurrent = d.value === props.level;
            const isFocused = i === focusIndex;
            return (
              <li
                key={d.value}
                role="option"
                aria-selected={isCurrent}
                className={
                  'permission-picker__item'
                  + (isCurrent ? ' permission-picker__item--current' : '')
                  + (isFocused ? ' permission-picker__item--focus' : '')
                  + ` permission-picker__item--${d.risk}`
                }
                onMouseEnter={() => setFocusIndex(i)}
                onClick={() => onSelect(d.value)}
              >
                <span className="permission-picker__item-row">
                  <Icon size={14} strokeWidth={2} aria-hidden="true" />
                  <span className="permission-picker__item-label">{d.label}</span>
                  {isCurrent ? (
                    <span className="permission-picker__item-mark" aria-hidden="true">✓</span>
                  ) : null}
                </span>
                <span className="permission-picker__item-desc">{d.description}</span>
                {d.risk === 'high' ? (
                  <span className="permission-picker__item-warn" role="note">
                    高风险：可能执行任意命令或修改项目外文件
                  </span>
                ) : null}
              </li>
            );
          })}
          <li
            role="presentation"
            className="permission-picker__footer"
            aria-hidden="true"
          >
            {props.source === 'conversation'
              ? '当前会话覆盖设置默认'
              : '来源：设置默认'}
          </li>
        </ul>
      ) : null}
    </div>
  );
}

function describeLevel(level: PermissionLevel): PermissionLevelDescriptor {
  // Defensive: the controlled value must be one of the four; we look
  // it up directly so an unknown future level still falls back to
  // the recommended default instead of throwing.
  return (
    PERMISSION_LEVELS.find((d) => d.value === level) ?? PERMISSION_LEVELS[0]!
  );
}
