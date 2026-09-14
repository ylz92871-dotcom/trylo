import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { EyeOff, GraduationCap, ShieldOff, X } from 'lucide-react';
import type { LearningDirective } from '../../user-learning/types';

interface DirectiveChoice {
  readonly id: 'no_preferences' | 'no_learning' | 'incognito';
  readonly label: string;
  readonly description: string;
  readonly directive: LearningDirective;
}

const CHOICES: readonly DirectiveChoice[] = [
  {
    id: 'no_preferences',
    label: '本次不使用个人偏好',
    description: '本轮不注入已有个人规则，但仍可从结果中学习。',
    directive: {
      applyExistingPreferences: false,
      collectNewLearning: true,
      retention: 'normal',
    },
  },
  {
    id: 'no_learning',
    label: '本次不学习',
    description: '本轮仍可使用已有偏好，但不提取新证据。',
    directive: {
      applyExistingPreferences: true,
      collectNewLearning: false,
      retention: 'normal',
    },
  },
  {
    id: 'incognito',
    label: '无痕任务',
    description: '不使用偏好、不学习，并在结束后清除本轮 Trace 文本。',
    directive: {
      applyExistingPreferences: false,
      collectNewLearning: false,
      retention: 'session_only',
      reason: 'user_requested_private',
    },
  },
];

export interface LearningDirectiveMenuProps {
  readonly value?: LearningDirective;
  readonly onChange: (value: LearningDirective | undefined) => void;
}

function choiceFor(value: LearningDirective | undefined): DirectiveChoice | undefined {
  if (!value) return undefined;
  return CHOICES.find((choice) => (
    choice.directive.applyExistingPreferences === value.applyExistingPreferences
    && choice.directive.collectNewLearning === value.collectNewLearning
    && choice.directive.retention === value.retention
  ));
}

export function LearningDirectiveMenu(props: LearningDirectiveMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const selected = choiceFor(props.value);

  const close = useCallback((restoreFocus = false): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target && !rootRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, open]);

  if (selected) {
    const Icon = selected.id === 'incognito' ? ShieldOff : selected.id === 'no_learning' ? GraduationCap : EyeOff;
    return (
      <div className="learning-directive learning-directive--selected" ref={rootRef}>
        <button
          ref={triggerRef}
          type="button"
          className="learning-directive__chip"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          title="仅对下一条发送生效"
        >
          <Icon size={13} aria-hidden="true" />
          <span>{selected.label}</span>
        </button>
        <button
          type="button"
          className="learning-directive__clear"
          onClick={() => props.onChange(undefined)}
          aria-label={`取消${selected.label}`}
          title="取消一次性学习选项"
        >
          <X size={12} aria-hidden="true" />
        </button>
        {open ? <DirectiveMenu id={menuId} onSelect={(value) => { props.onChange(value); close(true); }} /> : null}
      </div>
    );
  }

  return (
    <div className="learning-directive" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="learning-directive__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="设置下一条消息的学习选项"
        title="下一条消息的学习选项"
      >
        <EyeOff size={13} aria-hidden="true" />
        <span>学习选项</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? <DirectiveMenu id={menuId} onSelect={(value) => { props.onChange(value); close(true); }} /> : null}
    </div>
  );
}

function DirectiveMenu(props: {
  readonly id: string;
  readonly onSelect: (value: LearningDirective) => void;
}): ReactElement {
  return (
    <div id={props.id} role="menu" aria-label="下一条消息的学习选项" className="learning-directive__menu">
      <div className="learning-directive__heading">仅对下一条发送生效</div>
      {CHOICES.map((choice) => (
        <button
          key={choice.id}
          type="button"
          role="menuitem"
          className="learning-directive__item"
          onClick={() => props.onSelect({ ...choice.directive })}
        >
          <span className="learning-directive__item-label">{choice.label}</span>
          <span className="learning-directive__item-description">{choice.description}</span>
        </button>
      ))}
    </div>
  );
}
