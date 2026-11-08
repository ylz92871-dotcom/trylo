import { useEffect, useLayoutEffect, useRef, type ReactElement, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { PanelsTopLeft, Check, Code2 } from 'lucide-react';
import type { CodeMode, TopLevelMode } from '../../host-adapter/types';

const modes: readonly { value: CodeMode; label: string; hint: string }[] = [
  { value: 'agent', label: '执行', hint: '修改代码，运行工具并验证' },
  { value: 'chat', label: '对话', hint: '讨论问题与代码' },
  { value: 'plan', label: '计划', hint: '先制定方案' },
  { value: 'cognition', label: '偏好', hint: '告诉 Trylo 你希望怎样协作' },
];

export interface ModePopoverProps {
  readonly current: CodeMode;
  readonly kind?: TopLevelMode;
  readonly onKindChange?: (mode: TopLevelMode) => void;
  readonly onSelect: (mode: CodeMode) => void;
  readonly onClose: () => void;
  readonly anchorRef: RefObject<HTMLElement | null>;
}

export function ModePopover(props: ModePopoverProps): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const closeAndFocusTrigger = (): void => {
    props.onClose();
    props.anchorRef.current?.focus();
  };
  useLayoutEffect(() => {
    const place = (): void => {
      const menu = root.current;
      const anchor = props.anchorRef.current;
      if (!menu || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      const above = rect.top - 16;
      const below = window.innerHeight - rect.bottom - 16;
      const down = below >= menu.scrollHeight || below > above;
      const maxHeight = Math.max(96, down ? below : above);
      const height = Math.min(menu.scrollHeight, maxHeight);
      Object.assign(menu.style, {
        left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 268))}px`,
        top: `${down ? rect.bottom + 8 : Math.max(8, rect.top - height - 8)}px`,
        maxHeight: `${maxHeight}px`,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [props.anchorRef]);
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !props.anchorRef.current?.contains(target)) close.current();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [props.anchorRef]);

  return createPortal(<div ref={root} className="mode-popover mode-popover--anchored" role="menu" aria-label="任务类型"
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeAndFocusTrigger(); }
      // Let native Tab advance from the trigger once the portal is dismissed.
      if (event.key === 'Tab') closeAndFocusTrigger();
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
    {props.onKindChange && <div className="mode-popover__kinds" role="group" aria-label="工作区域">
      {(['code', 'work'] as const).map((kind) => <button type="button" role="menuitemradio" key={kind}
        aria-checked={(props.kind ?? 'code') === kind} onClick={() => { props.onKindChange?.(kind); closeAndFocusTrigger(); }}>
        {kind === 'code' ? <Code2 size={16} /> : <PanelsTopLeft size={16} />}<span>{kind === 'code' ? 'Code · 编程' : 'Work · 工作'}</span>
        {(props.kind ?? 'code') === kind && <Check size={14} />}
      </button>)}
    </div>}
    {props.kind !== 'work' && <div className="mode-popover__intents" role="group" aria-label="Code 的工作方式">
      <span className="mode-popover__heading">Code 的工作方式</span>
      {modes.map((mode) => <button key={mode.value} type="button" role="menuitemradio" aria-checked={props.current === mode.value}
        onClick={() => { props.onSelect(mode.value); closeAndFocusTrigger(); }}><span>{mode.label}<small>{mode.hint}</small></span>{props.current === mode.value && <Check size={14} />}</button>)}
    </div>}
  </div>, document.body);
}
