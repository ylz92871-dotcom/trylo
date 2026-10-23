import { useId, useState, type ReactElement } from 'react';
import { Check, ChevronDown, ChevronRight, CircleAlert, Clock3, Layers3, LoaderCircle, Square } from 'lucide-react';
import type { SubagentMessage } from './types';
import { AgentAvatar } from './AgentAvatar';
import '../../styles/components/collaboration-group.css';

export function agentLabel(agent: SubagentMessage): string {
  if (agent.displayName) return agent.displayName;
  const names: Record<string, string> = { 'general-purpose': '通用协作', subagent: '协作智能体',
    worker: '执行', reviewer: '审查', verifier: '验证', Explore: '探索', default: '通用协作' };
  return names[agent.agentType] ?? agent.agentType;
}

export function agentStatus(agent: SubagentMessage): string {
  if (agent.parked && agent.status === 'done') return '已答复 · 已释放名额';
  if (agent.status === 'waiting' && agent.result !== undefined) return '已答复';
  return { running: '进行中', waiting: '等待中', done: '已完成', failed: '未完成', cancelled: '已停止' }[agent.status];
}

export function AgentStatusIcon({ agent }: { agent: SubagentMessage }): ReactElement {
  const Icon = agent.status === 'running' ? LoaderCircle : agent.status === 'done'
    || (agent.status === 'waiting' && agent.result !== undefined) ? Check
    : agent.status === 'failed' ? CircleAlert : agent.status === 'cancelled' ? Square : Clock3;
  return <Icon size={15} aria-hidden="true" className={`collaboration__status-icon collaboration__status-icon--${agent.status}`} />;
}

export interface CollaborationGroupProps {
  readonly agents: readonly SubagentMessage[];
  readonly active: boolean;
  readonly selectedId?: string | null;
  readonly onSelect?: (messageId: string) => void;
}

export function CollaborationGroup({ agents, active, selectedId, onSelect }: CollaborationGroupProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const members = [...new Map(agents.map(agent => [agent.subagentId ?? agent.id, agent])).values()];
  return <section className={`collaboration${expanded ? ' collaboration--expanded' : ''}`} aria-label="智能体协作">
    <button type="button" className="collaboration__toggle" aria-expanded={expanded} aria-controls={listId}
      aria-label={`${members.length + 1} 个智能体 1 主控 · ${members.length} 协作`}
      onClick={() => setExpanded(value => !value)}>
      <span className="collaboration__avatars" aria-hidden="true">{members.slice(0, 3).map(agent => <AgentAvatar key={agent.subagentId ?? agent.id} agent={agent} size={16} />)}</span>
      <strong>{members.length + 1} 个智能体</strong>
      <span className="collaboration__composition">1 主控 · {members.length} 协作</span>
      {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
    </button>
    <div id={listId} hidden={!expanded} className="collaboration__members">
      <div className="collaboration__member collaboration__lead"><Layers3 size={15} aria-hidden="true" />
        <span>Trylo <span className="collaboration__role">主控</span></span>
        <span className="collaboration__state">{active ? '统筹中' : '本轮已结束'}</span><span /></div>
      {members.map(agent => <button type="button" className="collaboration__member" key={agent.id}
        aria-label={`查看${agentLabel(agent)}的会话`} aria-pressed={selectedId === agent.id}
        onClick={() => onSelect?.(agent.id)}>
        <AgentAvatar agent={agent} size={20} /><span className="collaboration__name">{agentLabel(agent)}</span>
        <span className={`collaboration__state collaboration__state--${agent.status}`}>{agentStatus(agent)}</span>
        <ChevronRight size={12} aria-hidden="true" />
      </button>)}
    </div>
  </section>;
}
