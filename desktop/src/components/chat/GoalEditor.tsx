import { useEffect, useRef, type ReactElement } from 'react';
import { Goal, RotateCcw, X } from 'lucide-react';

export type GoalEditorKind = 'create' | 'edit' | 'refill';
export interface GoalEditorProps {
  readonly kind: GoalEditorKind;
  readonly objective: string;
  readonly budget: string;
  readonly locked: boolean;
  readonly canSave: boolean;
  readonly error: string;
  readonly hint?: string;
  readonly onObjective: (value: string) => void;
  readonly onBudget: (value: string) => void;
  readonly onClose: () => void;
  readonly onRevert: () => void;
  readonly onSave: () => void;
}

export function GoalEditor(props: GoalEditorProps): ReactElement {
  const root = useRef<HTMLElement>(null);
  const opener = useRef(document.activeElement);
  useEffect(() => {
    root.current?.querySelector<HTMLTextAreaElement | HTMLInputElement>(props.kind === 'refill' ? 'input' : 'textarea')?.focus();
    const previous = opener.current;
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [props.kind]);
  const title = props.kind === 'create' ? '设置目标' : props.kind === 'refill' ? '增加目标预算' : '编辑目标';
  return <aside ref={root} className="goal-editor" aria-label={title} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && props.canSave) { event.preventDefault(); props.onSave(); }
  }}>
    <header className="goal-editor__header"><span><Goal size={16} aria-hidden="true" />{title}</span>
      <button type="button" className="goal-control__icon" onClick={props.onClose} aria-label="关闭目标编辑"><X size={16} /></button></header>
    <div className="goal-editor__toolbar"><span>{props.locked ? '等待当前执行停止…' : '当前聊天'}</span>
      <button type="button" className="goal-control__icon" disabled={props.locked} onClick={props.onRevert} title="还原修改" aria-label="还原修改"><RotateCcw size={14} /></button>
      <button type="button" className="goal-editor__save" disabled={!props.canSave} onClick={props.onSave}>
        {props.kind === 'create' ? '开始目标' : props.kind === 'refill' ? '增加预算并继续' : '保存'}</button></div>
    <textarea aria-label="目标" value={props.objective} maxLength={2000} readOnly={props.kind === 'refill'} disabled={props.locked}
      onChange={event => props.onObjective(event.target.value)} placeholder="描述要完成的结果和验收要求…" />
    <div className="goal-editor__settings"><label htmlFor="goal-token-budget">{props.kind === 'refill' ? '新的总 Token 预算' : 'Token 预算（可选）'}</label>
      <input id="goal-token-budget" aria-label="Token 预算" type="number" min={1} step={1} inputMode="numeric" value={props.budget}
        disabled={props.locked} onChange={event => props.onBudget(event.target.value)} placeholder="不设置" />
      <p>{props.hint ?? (props.kind === 'edit' ? '保存会保留已用量。修改后需点击继续目标。' : '在当前聊天持续推进，可随时暂停。')}</p>
      {props.error && <p className="goal-control__error" role="alert">{props.error}</p>}
    </div>
  </aside>;
}
