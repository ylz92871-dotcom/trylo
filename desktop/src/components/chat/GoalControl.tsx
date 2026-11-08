import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Goal, Pause, Pencil, Play, X } from 'lucide-react';
import type { GoalControl as GoalAction, GoalSnapshot } from '../../domain/goal';
import { GoalEditor, type GoalEditorKind } from './GoalEditor';

const LABELS = { active: '目标进行中', paused_by_user: '目标已暂停', paused_by_system: '执行已暂停',
  budget_exhausted: '预算已用尽', blocked: '需要处理阻碍', complete: '目标已完成', cancelled: '已取消' };
const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
type Pending = { readonly action: GoalAction; readonly baseline?: GoalSnapshot };

function acknowledged(pending: Pending, goal: GoalSnapshot | undefined): boolean {
  if (!goal || goal === pending.baseline) return false;
  const action = pending.action;
  if (action.action === 'create' || action.action === 'edit') return goal.objective === action.objective
    && (action.tokenBudget === undefined || goal.tokenBudget === action.tokenBudget);
  if (action.action === 'pause') return goal.status === 'paused_by_user' || goal.status === 'budget_exhausted';
  if (action.action === 'cancel') return goal.status === 'cancelled';
  return goal.status === 'active';
}

export function GoalControl(props: { readonly goal?: GoalSnapshot; readonly running: boolean; readonly draft: string;
  readonly onAction: (action: GoalAction) => Promise<void>; readonly children?: (open: () => void) => ReactElement }): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<Element | null>(null);
  const [editor, setEditor] = useState<GoalEditorKind>();
  const [objective, setObjective] = useState('');
  const [budget, setBudget] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending>();
  const goal = props.goal;
  const unfinished = goal && goal.status !== 'complete' && goal.status !== 'cancelled';
  useLayoutEffect(() => { setPortal(root.current?.closest('.agent-conversation-layout') ?? document.body); }, []);
  useEffect(() => {
    if (!pending) return;
    if (acknowledged(pending, goal)) { setPending(undefined); if (pending.action.action !== 'pause') setEditor(undefined); }
  }, [goal, pending]);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => { setPending(undefined); setError('目标操作尚未确认，请查看聊天中的执行结果后重试。'); }, 30_000);
    return () => window.clearTimeout(timer);
  }, [pending]);
  const act = async (action: GoalAction): Promise<void> => {
    setError(''); setPending({ action, baseline: goal });
    try { await props.onAction(action); }
    catch (failure) { setPending(undefined); setError(failure instanceof Error ? failure.message : '目标操作未送达，请重试。'); }
  };
  const open = (kind: GoalEditorKind): void => {
    setError(''); setEditor(kind);
    setObjective(kind === 'create' ? props.draft.replace(/^\s*\/goal(?:\s+|$)/, '') : goal?.objective ?? '');
    setBudget(kind === 'refill' ? '' : kind === 'edit' && goal?.tokenBudget !== undefined ? String(goal.tokenBudget) : '');
    if (kind === 'edit' && props.running && goal?.status === 'active') void act({ version: 1, action: 'pause' });
  };
  const tokenBudget = budget.trim() ? Number(budget) : undefined;
  const budgetValid = tokenBudget === undefined || (Number.isSafeInteger(tokenBudget) && tokenBudget > 0);
  const preservingBudget = editor !== 'edit' || goal?.tokenBudget === undefined || (tokenBudget !== undefined && tokenBudget >= goal.tokenBudget);
  const canSave = !props.running && !pending && budgetValid && preservingBudget && (editor === 'refill'
    ? tokenBudget !== undefined && tokenBudget > (goal?.tokensUsed ?? 0) && tokenBudget >= (goal?.tokenBudget ?? 0)
    : !!objective.trim() && (editor !== 'edit' || objective.trim() !== goal?.objective || tokenBudget !== goal?.tokenBudget));
  const hint = unfinished && goal.usageUncertain ? '部分用量尚未确认。请核对后取消并重新设置目标。' : undefined;
  return <>
    <div ref={root} className={`goal-composer${unfinished ? ' goal-composer--active' : ''}`}>
      {unfinished && <section className="goal-control" aria-label="目标模式">
        <Goal size={14} className="goal-control__symbol" aria-hidden="true" />
        <button type="button" className="goal-control__summary" disabled={!!pending} onClick={() => open('edit')} title={goal.objective}>
          <span className="goal-control__status" role="status">{goal.status === 'active' && !props.running ? '执行已中断，可继续' : LABELS[goal.status]}</span>
          <span className="goal-control__objective">{goal.objective}</span>
          <span className="goal-control__usage">· {compactNumber.format(goal.tokensUsed)}{goal.tokenBudget === undefined ? ' token' : ` / ${compactNumber.format(goal.tokenBudget)}`}</span>
        </button>
        <div className="goal-control__actions">
          <button type="button" className="goal-control__icon" disabled={!!pending} onClick={() => { void act({ version: 1, action: 'cancel' }); }} aria-label="取消目标" title="清除目标"><X size={13} /></button>
          {goal.status === 'active' && props.running ? <button type="button" className="goal-control__icon" disabled={!!pending} onClick={() => { void act({ version: 1, action: 'pause' }); }} aria-label="暂停目标" title="暂停目标"><Pause size={13} /></button>
            : <button type="button" className="goal-control__icon" disabled={props.running || !!pending || !!goal.usageUncertain} aria-label="继续目标" title={hint ?? '继续目标'} onClick={() => {
              if (goal.status === 'budget_exhausted') open('refill'); else void act({ version: 1, action: 'resume' });
            }}><Play size={13} /></button>}
          <button type="button" className="goal-control__icon" disabled={!!pending || !!goal.usageUncertain} onClick={() => open('edit')} aria-label="编辑目标" title={hint ?? '编辑目标'}><Pencil size={13} /></button>
        </div>
      </section>}
      {props.children ? props.children(() => open(unfinished ? 'edit' : 'create'))
        : !unfinished && <button type="button" className="goal-control__entry" disabled={props.running || !!pending} onClick={() => open('create')}><Goal size={14} />设置目标</button>}
    </div>
    {hint && <p className="goal-control__hint">{hint}</p>}
    {error && !editor && <p className="goal-control__error" role="alert">{error}</p>}
    {editor && portal && createPortal(<GoalEditor kind={editor} objective={objective} budget={budget} locked={props.running || !!pending}
      canSave={canSave && !(unfinished && goal?.usageUncertain)} error={error} hint={hint} onObjective={setObjective} onBudget={setBudget}
      onClose={() => setEditor(undefined)} onRevert={() => { setObjective(editor === 'create' ? props.draft : goal?.objective ?? ''); setBudget(goal?.tokenBudget === undefined ? '' : String(goal.tokenBudget)); }}
      onSave={() => { void act(editor === 'refill' ? { version: 1, action: 'resume', tokenBudget }
        : { version: 1, action: editor, objective: objective.trim(), ...(tokenBudget === undefined ? {} : { tokenBudget }) }); }} />, portal)}
  </>;
}
