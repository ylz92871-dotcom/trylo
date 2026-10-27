import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ArrowUp, X } from 'lucide-react';
import { agentLabel } from './CollaborationGroup';
import { AgentAvatar } from './AgentAvatar';
import type { SubagentMessage } from './types';
import { MessageList } from './MessageList';
import { memberTranscript } from './member-transcript';
import type { SendSubagentInput, SubagentInputMode } from '../../host-adapter/subagent-contract';

export interface SubagentConversationProps {
  readonly variant?: 'panel' | 'inline' | 'team';
  readonly avatar?: ReactNode;
  readonly onOpenArtifact?: (path: string) => void;
  readonly workspacePath?: string;
  readonly artifactHost?: import('@trylo/work').HostAdapter;
  readonly observing?: boolean;
  readonly agent: SubagentMessage;
  readonly onClose: () => void;
  readonly drafts: Map<string, string>;
  readonly onSend?: SendSubagentInput;
}

export function SubagentConversation({ agent, onClose, drafts, onSend, variant = 'panel', avatar, onOpenArtifact, workspacePath, artifactHost, observing = true }: SubagentConversationProps): ReactElement {
  const [text, setText] = useState(() => drafts.get(agent.id) ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<SubagentInputMode>('append');
  const mounted = useRef(true);
  const closeButton = useRef<HTMLButtonElement>(null);
  const messages = useMemo(() => memberTranscript(agent), [agent]);
  useEffect(() => {
    mounted.current = true;
    closeButton.current?.focus();
    return () => { mounted.current = false; };
  }, []);
  const canSend = Boolean(onSend && agent.canReceiveInput && (agent.status === 'running' || agent.status === 'waiting' || (agent.status === 'done' && agent.parked)));
  const submit = async (): Promise<void> => {
    if (!canSend || pending || !text.trim()) return;
    const sent = text.trim();
    setPending(true); setError('');
    try {
      const target = agent.taskId ?? agent.subagentId ?? agent.id;
      if (mode === 'append') await onSend?.(target, sent);
      else await onSend?.(target, sent, mode);
      if (drafts.get(agent.id)?.trim() === sent) drafts.delete(agent.id);
      if (mounted.current) setText('');
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '发送失败，请重试。');
    } finally { if (mounted.current) setPending(false); }
  };
  const modeControl = <label className="subagent-conversation__mode">发送方式
    <select aria-label="发送方式" value={mode} disabled={pending}
      onChange={event => { const selected = event.target.value; if (selected === 'append' || selected === 'replace_queued' || selected === 'restart') setMode(selected); }}>
      <option value="append">追加下一步</option><option value="replace_queued">替换待办要求</option><option value="restart">停止当前执行后重启</option>
    </select></label>;
  return <aside className={`subagent-conversation${variant === 'inline' ? ' subagent-conversation--inline' : variant === 'team' ? ' subagent-conversation--team' : ''}`} aria-label={`${agentLabel(agent)}的会话`}>
    {variant === 'panel' && <><header className="subagent-conversation__header"><div>{avatar ?? <AgentAvatar agent={agent} />}<h2>{agentLabel(agent)}</h2></div>
      <button ref={closeButton} type="button" onClick={onClose} aria-label="关闭成员会话"><X size={18} /></button></header>
    <div className="subagent-conversation__parent"><span>来自当前主对话</span><button type="button" onClick={onClose}>返回主对话</button></div></>}
    <div className="subagent-conversation__body" aria-label="成员会话内容">
      <MessageList surface="code" messages={messages} running={observing && agent.status === 'running'} onOpenArtifact={onOpenArtifact} workspacePath={workspacePath} artifactHost={artifactHost} />
    </div>
      {agent.budget && <p className="subagent-conversation__budget" role="status">
        已用 {agent.budget.tokensUsed} / {agent.budget.tokenLimit} token，剩余 {agent.budget.tokensRemaining}；
        {agent.budget.timeoutMode === 'active' ? '可执行时间' : '运行时间'}剩余 {Math.ceil(agent.budget.timeRemainingMs / 1000)} 秒（最近上报）
      </p>}
      {agent.error && <p className="subagent-conversation__error" role="alert">{agent.error}</p>}
      {!agent.observations?.length && agent.status !== 'running' && <p className="subagent-conversation__history-note">这份历史只保存了任务与答复，未保留逐条执行记录。</p>}
      {agent.artifacts && agent.artifacts.length > 0 && <details><summary>交付物 · {agent.artifacts.length}</summary>
        <ul>{agent.artifacts.map(path => <li key={path}>{path}</li>)}</ul></details>}
    <div className="subagent-conversation__compose">
      {canSend ? <form className={variant === 'team' ? 'input-bar' : undefined} onSubmit={event => { event.preventDefault(); void submit(); }}>
        {variant !== 'team' && modeControl}
        <label className="subagent-conversation__input-label" htmlFor={`subagent-input-${agent.id}`}>向{agentLabel(agent)}补充要求</label>
        <textarea className={variant === 'team' ? 'input-bar__input' : undefined} id={`subagent-input-${agent.id}`} value={text} disabled={pending} maxLength={16000}
          onChange={event => { const value = event.target.value; setText(value); drafts.set(agent.id, value); }} rows={3}
          onKeyDown={event => { if (variant === 'team' && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}
          placeholder={`向${agentLabel(agent)}补充要求…`} />
        <div className={variant === 'team' ? 'input-bar__toolbar' : undefined}>{variant === 'team' && modeControl}<span>{pending ? '正在发送…' : mode === 'restart' ? '停止当前执行，接着已记录进度继续' : mode === 'replace_queued' ? '替换尚未开始的要求' : variant === 'team' ? `${agentLabel(agent)} · 仅当前任务` : '沿用当前任务的工具授权'}</span><button className={variant === 'team' ? 'input-bar__send' : undefined} type="submit" disabled={pending || !text.trim()} aria-label="发送给该智能体"><ArrowUp size={17} /></button></div>
      </form> : <p>{agent.managedSessionId ? '这是后台任务，已有答复与交付物会保留。' : '此任务当前不接收补充要求，可回到主对话继续指派。'}</p>}
      {error && <p role="alert" className="subagent-conversation__error">{error}</p>}
    </div>
  </aside>;
}
