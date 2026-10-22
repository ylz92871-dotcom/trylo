import type { ReactElement } from 'react';
import { ChevronRight } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import { AgentStatusIcon, agentLabel, agentStatus } from './CollaborationGroup';
import type { SubagentMessage } from './types';

/** One real member event in the main transcript; the full text stays in its conversation. */
export function AgentParticipation({ agent, selected, onSelect }: {
  readonly agent: SubagentMessage;
  readonly selected: boolean;
  readonly onSelect?: (id: string) => void;
}): ReactElement {
  const text = (agent.error || agent.summary || agent.result || agent.prompt || '').replace(/\s+/g, ' ').trim();
  return <section className="agent-participation" role="listitem" aria-label={`${agentLabel(agent)}参与事件`}>
    <AgentAvatar agent={agent} />
    <div className="agent-participation__content">
      <button type="button" className="agent-participation__open" onClick={() => onSelect?.(agent.id)}
        aria-label={`打开${agentLabel(agent)}的参与详情`} aria-pressed={selected}>
        <strong>{agentLabel(agent)}</strong><AgentStatusIcon agent={agent} />
        <span className={agent.status === 'failed' ? 'collaboration__failure' : ''}>{agentStatus(agent)}</span>
        <ChevronRight size={13} aria-hidden="true" />
      </button>
      {text && <p className={agent.error ? 'agent-participation__error' : ''}>{text.length > 180 ? `${text.slice(0, 180)}…` : text}</p>}
    </div>
  </section>;
}
