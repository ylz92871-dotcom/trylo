import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeWorkspaceSuspension, createCollaborationLearningPort, type CollaborationLearningRuntime,
  type CollaborationPracticeSummary, type CollaborationStatus } from '../../collaboration-learning/cli';

export function CollaborationLearningPanel({ runtime }: { readonly runtime: CollaborationLearningRuntime }) {
  const [status, setStatus] = useState<CollaborationStatus | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<{ readonly message: string; readonly code: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const port = useMemo(() => createCollaborationLearningPort(runtime), [runtime.process, runtime.cliPath, runtime.nodeProgram, runtime.cwd]);
  const reload = useCallback(async (signal: AbortSignal) => {
    setPhase('loading'); setError(null);
    const result = await port.status(signal);
    if (signal.aborted) return;
    if (result.ok) { setStatus(result); setPhase('ready'); }
    else { setError({ message: '暂时无法读取当前工作区的协作学习状态。请确认 CLI 可用后刷新。', code: result.reason }); setPhase('error'); }
  }, [port]);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    setStatus(null); setBusy(null); void reload(active.signal);
    return () => { active.abort(); controller.current = null; };
  }, [reload]);
  const correct = async (practice: CollaborationPracticeSummary) => {
    const signal = controller.current?.signal;
    if (signal === undefined || signal.aborted || busy !== null) return;
    const previous = activeWorkspaceSuspension(practice);
    setBusy(practice.familyId); setError(null);
    const result = await port.correct({ familyId: practice.familyId, action: previous === undefined ? 'suspend' : 'restore',
      evidenceRef: `user:desktop-collaboration:${crypto.randomUUID()}`, ...(previous === undefined ? {} : { replacesCorrectionId: previous }) }, signal);
    if (signal.aborted) return;
    setBusy(null);
    if (result.ok) await reload(signal);
    else { setError({ message: '纠正未能确认。请刷新状态后再操作。', code: result.reason }); setPhase('error'); }
  };
  const phaseLabels: Readonly<Record<string, string>> = { running: '学习中', reserved: '已预留额度', completed: '已完成', waiting_evidence: '等待协作证据',
    cancelled: '已取消', failed: '未完成', exhausted: '额度已用完' };
  return <section aria-label="协作学习状态与纠正" style={{ overflowWrap: 'anywhere' }}>
    <p className="settings-modal__hint">当前工作区：{runtime.cwd}</p>
    <button type="button" className="settings-modal__btn settings-modal__btn--ghost" disabled={phase === 'loading' || busy !== null}
      onClick={() => { const signal = controller.current?.signal; if (signal !== undefined) void reload(signal); }}>刷新状态</button>
    {phase === 'loading' && <p role="status" className="settings-modal__hint">正在读取协作学习状态…</p>}
    {error !== null && <div role="alert"><p className="settings-modal__hint">{error.message}</p>
      <details><summary>诊断信息</summary><code>{error.code}</code></details></div>}
    {status !== null && <>
      <p className="settings-modal__hint">{status.cycles.length} 个学习额度记录；{status.practices.length} 项协作做法。试用不代表质量已验证。</p>
      {status.cycles.slice(-4).map(cycle => <p key={cycle.cycleId} className="settings-modal__hint">
        {phaseLabels[cycle.phase] ?? cycle.phase} · 已记账 {cycle.spentTokens.toLocaleString()} / {cycle.maxTokens.toLocaleString()} tokens · {cycle.spentCalls} 次学习调用
      </p>)}
      {status.practices.length === 0 && <p className="settings-modal__hint">尚无协作做法。团队任务会在有实际协作证据和剩余额度时自主学习。</p>}
      {status.practices.map(practice => <details key={practice.versionId}>
        <summary>{practice.title} · {practice.status === 'suspended' ? '此工作区已停用' : '有条件试用'}</summary>
        <p className="settings-modal__desc">{practice.hypothesis}</p>
        <p className="settings-modal__hint">依赖条件：{practice.dependency}；角色：{practice.roles.join('、') || '不限'}。</p>
        <ul>{practice.actions.map(action => <li key={action.actionId}>{action.audience === 'parent' ? '主智能体' : '成员'}：{action.instruction}</li>)}</ul>
        <p className="settings-modal__hint">依据：{practice.evidenceRefs.join('、') || '无可展示引用'}</p>
        {practice.corrections.map(item => <p key={item.factId} className="settings-modal__hint">
          {item.action === 'suspend' ? '停用' : '恢复'} · {item.scopeKind === 'workspace' ? '此工作区'
            : item.scopeKind === 'class' ? `任务类型 ${item.taskFamily} / 角色 ${item.role}` : `单次任务 ${item.taskId}`} · {item.evidenceRef}
        </p>)}
        <button type="button" className="settings-modal__btn settings-modal__btn--ghost"
          disabled={phase !== 'ready' || busy !== null || practice.status === 'suspended' && activeWorkspaceSuspension(practice) === undefined}
          onClick={() => { void correct(practice); }}>
          {busy === practice.familyId ? '正在记录纠正…' : activeWorkspaceSuspension(practice) === undefined ? '在此工作区停用' : '恢复此工作区试用'}
        </button>
      </details>)}
    </>}
  </section>;
}
