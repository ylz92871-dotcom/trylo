import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { ArrowUp, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AgentStatusIcon, agentLabel, agentStatus } from './CollaborationGroup';
import { AgentAvatar } from './AgentAvatar';
import type { SubagentMessage } from './types';
import { createFollowController, FOLLOW_TAIL_THRESHOLD } from './follow-controller';
import type { SendSubagentInput, SubagentInputMode } from '../../host-adapter/subagent-contract';

export interface SubagentConversationProps {
  readonly agent: SubagentMessage;
  readonly onClose: () => void;
  readonly drafts: Map<string, string>;
  readonly onSend?: SendSubagentInput;
}

export function SubagentConversation({ agent, onClose, drafts, onSend }: SubagentConversationProps): ReactElement {
  const [text, setText] = useState(() => drafts.get(agent.id) ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<SubagentInputMode>('append');
  const mounted = useRef(true);
  const closeButton = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(createFollowController());
  const touchY = useRef(0);
  const [away, setAway] = useState(false);
  const pin = (): void => {
    const node = body.current;
    if (!node) return;
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    follow.current.sync({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight });
  };
  useLayoutEffect(() => { if (follow.current.isFollowing()) pin(); }, [agent.conversation, agent.result, agent.status]);
  useEffect(() => {
    mounted.current = true;
    closeButton.current?.focus();
    return () => { mounted.current = false; };
  }, []);
  const rounds = agent.conversation?.length ? agent.conversation
    : [{ round: 1, prompt: agent.prompt, result: agent.result ?? agent.summary }];
  const canSend = Boolean(onSend && agent.canReceiveInput && (agent.status === 'running' || agent.status === 'waiting' || (agent.status === 'done' && agent.parked)));
  const submit = async (): Promise<void> => {
    if (!canSend || pending || !text.trim()) return;
    const sent = text.trim();
    setPending(true); setError('');
    try {
      const target = agent.taskId ?? agent.subagentId ?? agent.id;
      if (mode === 'append') await onSend?.(target, sent);
      else await onSend?.(target, sent, mode);
      drafts.delete(agent.id);
      if (mounted.current) { setText(''); follow.current.rearm(); setAway(false); pin(); }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '发送失败，请重试。');
    } finally { if (mounted.current) setPending(false); }
  };
  return <aside className="subagent-conversation" aria-label={`${agentLabel(agent)}的会话`}>
    <header className="subagent-conversation__header"><div><AgentAvatar agent={agent} /><h2>{agentLabel(agent)}</h2></div>
      <button ref={closeButton} type="button" onClick={onClose} aria-label="关闭成员会话"><X size={18} /></button></header>
    <div className="subagent-conversation__parent"><span>来自当前主对话</span><button type="button" onClick={onClose}>返回主对话</button></div>
    <div ref={body} className="subagent-conversation__body" tabIndex={0} aria-label="成员会话内容"
      onWheel={event => { if (event.deltaY < 0) follow.current.pause(); }}
      onTouchStart={event => { touchY.current = event.touches[0]?.clientY ?? 0; }}
      onTouchMove={event => { const y = event.touches[0]?.clientY ?? touchY.current; if (y > touchY.current) follow.current.pause(); touchY.current = y; }}
      onKeyDown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) follow.current.pause(); }}
      onScroll={event => {
        const node = event.currentTarget;
        // Native scrolling has no virtual-list repositioning. Own pins sync
        // their baseline first; geometry compensates for collapsed content.
        follow.current.observe({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight });
        setAway(!follow.current.isFollowing() && node.scrollHeight - node.clientHeight - node.scrollTop > FOLLOW_TAIL_THRESHOLD);
      }}>
      {rounds.map(round => <section key={round.round} className="subagent-conversation__round" aria-label={`第 ${round.round} 轮`}>
        {round.prompt && <div className="subagent-conversation__instruction">{round.prompt}</div>}
        {round.result !== undefined && <div className="subagent-conversation__answer">
          <div className="subagent-conversation__speaker"><AgentAvatar agent={agent} size={20} /><span>{agentLabel(agent)}</span></div>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{round.result || '本轮未返回文字答复。'}</ReactMarkdown></div>}
      </section>)}
      <div className="subagent-conversation__status"><AgentStatusIcon agent={agent} />{agentStatus(agent)}</div>
      {agent.budget && <p className="subagent-conversation__budget" role="status">
        已用 {agent.budget.tokensUsed} / {agent.budget.tokenLimit} token，剩余 {agent.budget.tokensRemaining}；
        {agent.budget.timeoutMode === 'active' ? '可执行时间' : '运行时间'}剩余 {Math.ceil(agent.budget.timeRemainingMs / 1000)} 秒（最近上报）
      </p>}
      {agent.error && <p className="subagent-conversation__error" role="alert">{agent.error}</p>}
      {agent.artifacts && agent.artifacts.length > 0 && <details><summary>交付物 · {agent.artifacts.length}</summary>
        <ul>{agent.artifacts.map(path => <li key={path}>{path}</li>)}</ul></details>}
    </div>
    <div className="subagent-conversation__compose">
      {away && <button type="button" className="subagent-conversation__latest" onClick={() => { follow.current.rearm(); setAway(false); pin(); }}>回到最新 ↓</button>}
      {canSend ? <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label className="subagent-conversation__mode">发送方式
          <select aria-label="发送方式" value={mode} disabled={pending}
            onChange={event => { const selected = event.target.value; if (selected === 'append' || selected === 'replace_queued' || selected === 'restart') setMode(selected); }}>
            <option value="append">追加下一步</option><option value="replace_queued">替换待办要求</option><option value="restart">停止当前执行后重启</option>
          </select>
        </label>
        <label className="subagent-conversation__input-label" htmlFor={`subagent-input-${agent.id}`}>向{agentLabel(agent)}补充要求</label>
        <textarea id={`subagent-input-${agent.id}`} value={text} disabled={pending} maxLength={16000}
          onChange={event => { const value = event.target.value; setText(value); drafts.set(agent.id, value); }} rows={3}
          placeholder={`向${agentLabel(agent)}补充要求…`} />
        <div><span>{pending ? '正在发送…' : mode === 'restart' ? '停止当前执行，接着已记录进度继续' : mode === 'replace_queued' ? '替换尚未开始的要求' : '沿用当前任务的工具授权'}</span><button type="submit" disabled={pending || !text.trim()} aria-label="发送给该智能体"><ArrowUp size={17} /></button></div>
      </form> : <p>{agent.managedSessionId ? '这是后台任务，已有答复与交付物会保留。' : '此任务当前不接收补充要求，可回到主对话继续指派。'}</p>}
      {error && <p role="alert" className="subagent-conversation__error">{error}</p>}
    </div>
  </aside>;
}
