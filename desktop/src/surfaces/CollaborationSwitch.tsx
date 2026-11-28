import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Check, ChevronDown, UserRound, UsersRound } from 'lucide-react';
import { isMacPlatform } from '../utils/platform';
import { usePresenceTransition } from '../utils/use-presence-transition';
import type { CollaborationSurface } from './types';

export interface CollaborationSwitchProps {
  readonly value: CollaborationSurface;
  readonly onChange: (value: CollaborationSurface) => void;
  readonly disabled?: boolean;
  readonly onCompose?: () => void;
}

export function CollaborationSwitch(props: CollaborationSwitchProps): ReactElement {
  const [open, setOpen] = useState(false);
  const menuPresence = usePresenceTransition(open, 110);
  const anchor = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<'first' | 'last' | null>(null);
  const mac = isMacPlatform();
  const noDragProps = mac ? { 'data-tauri-drag-region': 'false' } : undefined;

  useEffect(() => {
    if (!open) return;

    const outside = (event: MouseEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);

    if (pendingFocus.current) {
      const items = getMenuItems();
      const target = pendingFocus.current === 'last' ? items[items.length - 1] : items[0];
      pendingFocus.current = null;
      target?.focus();
    }

    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const getMenuItems = (): HTMLButtonElement[] => {
    if (!menu.current) return [];
    return [...menu.current.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]')].filter(
      (item) => !item.disabled,
    );
  };

  const focusByIndex = (index: number): void => {
    const items = getMenuItems();
    if (items.length === 0) return;
    const clamped = ((index % items.length) + items.length) % items.length;
    items[clamped]?.focus();
  };

  const pick = (value: CollaborationSurface): void => {
    props.onChange(value);
    setOpen(false);
    anchor.current?.focus();
  };

  const handleContainerKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      setOpen(false);
      anchor.current?.focus();
      return;
    }

    if (event.key === 'Tab' && open) {
      setOpen(false);
      return;
    }

    if (!open) {
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !props.disabled) {
        event.preventDefault();
        pendingFocus.current = event.key === 'ArrowUp' ? 'last' : 'first';
        setOpen(true);
      }
      return;
    }

    const items = getMenuItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusByIndex(current < 0 ? 0 : current + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusByIndex(current < 0 ? items.length - 1 : current - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusByIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusByIndex(items.length - 1);
    }
  };

  const Icon = props.value === 'person' ? UserRound : UsersRound;

  return (
    <div ref={root} className="collaboration-switch" onKeyDown={handleContainerKeyDown} {...noDragProps}>
      <button
        ref={anchor}
        type="button"
        className="collaboration-switch__trigger"
        disabled={props.disabled}
        aria-label="协作方式"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          pendingFocus.current = null;
          setOpen((wasOpen) => !wasOpen);
        }}
        {...noDragProps}
      >
        <Icon size={mac ? 14 : 16} aria-hidden="true" />
        <span>{props.value === 'person' ? '个人' : '团队'}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {menuPresence.mounted && (
        <div
          ref={menu}
          className="collaboration-switch__menu"
          data-motion-state={menuPresence.state}
          role={menuPresence.state === 'exiting' ? undefined : 'menu'}
          aria-label={menuPresence.state === 'exiting' ? undefined : '协作方式'}
          aria-hidden={menuPresence.state === 'exiting' ? true : undefined}
          {...noDragProps}
        >
          {(['person', 'team'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={props.value === value}
              onClick={() => pick(value)}
            >
              {value === 'person' ? <UserRound size={15} /> : <UsersRound size={15} />}
              <span>{value === 'person' ? '个人对话' : '团队协作'}</span>
              {props.value === value && <Check size={14} />}
            </button>
          ))}
          {props.onCompose && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                props.onCompose?.();
                setOpen(false);
              }}
            >
              <UsersRound size={15} />
              <span>用团队做这件事</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
