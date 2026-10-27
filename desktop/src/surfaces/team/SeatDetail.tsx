import type { ReactElement } from 'react';
import { SEAT_STATUS_LABEL } from '../shared/status';
import { TEAM_ROLE_DISPLAY_NAME, TEAM_ROLE_DUTY } from './team-profile-types';
import type { SeatActivityItem, SeatInstance } from './team-types';
import { SubagentConversation } from '../../components/chat/SubagentConversation';
import type { SubagentMessage } from '../../components/chat/types';
import type { SendSubagentInput } from '../../host-adapter/subagent-contract';
import { X } from 'lucide-react';
import { TeamMark } from './run/TeamMark';
import { currentTask, memberState } from './run/team-presentation';
import { SeatExecutionEvents } from './run/SeatExecutionEvents';
import { assignmentText } from './team-progress-projection';

export interface SeatDetailProps {
  readonly observing?: boolean;
  readonly onOpenArtifact?: (path: string) => void;
  readonly artifactHost?: import('@trylo/work').HostAdapter;
  readonly workspacePath?: string;
  readonly embedded?: boolean;
  readonly conversationKey?: string;
  readonly drafts?: Map<string, string>;
  readonly onMemberInput?: SendSubagentInput;
  readonly seat: SeatInstance;
  readonly onBack: () => void;
  readonly onCancel?: (seatId: string) => void;
  readonly onOpenPerson?: () => void;
}

export function SeatDetail(props: SeatDetailProps): ReactElement {
  const { seat } = props;
  const name = seat.displayName ?? TEAM_ROLE_DISPLAY_NAME[seat.seat];
  const activity = seat.activity ?? [];
  const independent = seat.seat === 'reviewer' || seat.seat === 'verifier';
  const canCancel = seat.status === 'running' || seat.status === 'waiting_approval';
  const showConversation = props.drafts !== undefined && seat.taskId !== undefined;
  const status = seat.status === 'completed' ? 'done' : seat.status === 'waiting_approval' ? 'waiting'
    : seat.status === 'queued' ? 'waiting' : seat.status === 'running' && seat.awaitingInput ? 'waiting' : seat.status;
  const agent: SubagentMessage = { id: props.conversationKey ?? seat.id, subagentId: seat.id, taskId: seat.taskId,
    role: 'system', kind: 'subagent', createdAt: seat.startedAt ?? 0, source: 'trylo-v1', agentType: seat.seat,
    displayName: name, status, prompt: seat.prompt, result: seat.result, error: seat.error, round: seat.round,
    canReceiveInput: seat.canReceiveInput, parked: seat.parked, conversation: seat.conversation };
  const observations = seat.observations ?? activity.filter(item => item.kind !== 'note').map(item => ({ id: item.id, round: item.round ?? seat.round ?? 1,
    kind: item.kind === 'tool' ? 'tool' as const : 'result' as const, tool: item.label, at: item.at, ok: item.ok }));
  const detailedAgent = { ...agent, observations };

  if (props.embedded) return <div className="team-member-pane">
    <header className="team-member-head"><div className="team-member-head__identity"><TeamMark role={seat.seat} /><div><strong>{name}</strong><span title={currentTask(seat)}>{currentTask(seat)}</span></div></div>
      <div className="team-member-head__actions"><small>{memberState(seat)}</small><details className="team-menu"><summary>职责</summary><div className="team-menu__popup">{TEAM_ROLE_DUTY[seat.seat]}{independent ? ' · 保留独立判断' : ''}{props.onOpenPerson && <button onClick={props.onOpenPerson}>整体调整交给 Person</button>}</div></details>
        {props.onCancel && canCancel && <button className="team-text-action" onClick={() => props.onCancel?.(seat.id)}>取消</button>}
        <button className="team-icon-button" aria-label="返回团队视图" onClick={props.onBack}><X size={17} /></button></div></header>
    {showConversation && props.drafts ? <SubagentConversation key={agent.id} agent={{ ...detailedAgent,
      prompt: agent.prompt === undefined ? undefined : assignmentText(agent.prompt),
      conversation: agent.conversation?.map(round => ({ ...round, prompt: round.prompt === undefined ? undefined : assignmentText(round.prompt) })) }} variant="team" avatar={<TeamMark role={seat.seat} size={20} />}
      onOpenArtifact={props.onOpenArtifact} artifactHost={props.artifactHost} workspacePath={props.workspacePath}
      observing={props.observing}
      drafts={props.drafts} onClose={props.onBack} onSend={props.onMemberInput} />
      : <div className="team-member-fallback"><p>{seat.prompt ?? (seat.status === 'queued' ? '等待开始这项任务。' : '尚未提供任务说明。')}</p><SeatExecutionEvents activity={activity} />
        {seat.result && <p className="seat-detail__result">{seat.result}</p>}{seat.error && <p role="alert">{seat.error}</p>}
        {props.onOpenPerson && <button className="team-text-action" onClick={props.onOpenPerson}>向 Person 补充要求</button>}</div>}
    {seat.status === 'waiting_approval' && props.onOpenPerson && <button className="team-text-action team-member-approval" onClick={props.onOpenPerson}>去对话里批准</button>}
  </div>;

  return (
    <div className="seat-detail">
      <div className="seat-detail__meta-line">
        <span>{name}</span>
        <span>{SEAT_STATUS_LABEL[seat.status]}</span>
        {independent ? <span>独立</span> : null}
      </div>
      <p className="seat-detail__duty">{TEAM_ROLE_DUTY[seat.seat]}</p>

      {activity.length > 0 ? (
        <ol className="seat-detail__activity">
          {activity.slice(-12).map((item) => (
            <li key={item.id} className={activityClass(item)}>
              {item.label}
            </li>
          ))}
        </ol>
      ) : (
        <p className="seat-detail__empty">
          {seat.status === 'queued' ? '还没轮到。' : '还没有动作。'}
        </p>
      )}

      {showConversation && props.drafts ? <SubagentConversation key={agent.id} agent={detailedAgent} variant="inline" drafts={props.drafts}
        onClose={props.onBack} onSend={props.onMemberInput} /> : null}

      {!showConversation && seat.result ? (
        <p className="seat-detail__result">{seat.result}</p>
      ) : null}
      {!showConversation && seat.status === 'failed' ? (
        <p className="seat-detail__result seat-detail__result--failed">{seat.error ?? '失败。'}</p>
      ) : null}

      {seat.status === 'waiting_approval' && props.onOpenPerson ? (
        <button type="button" className="seat-detail__link" onClick={props.onOpenPerson}>
          去对话里批准
        </button>
      ) : null}

      <div className="seat-detail__actions">
        <button type="button" className="seat-detail__link" onClick={props.onBack}>
          收起
        </button>
        {props.onCancel && canCancel ? (
          <button type="button" className="seat-detail__link" onClick={() => props.onCancel?.(seat.id)}>
            取消
          </button>
        ) : null}
      </div>
    </div>
  );
}

function activityClass(item: SeatActivityItem): string {
  if (item.kind === 'result' && item.ok === false) return 'seat-detail__activity-item seat-detail__activity-item--fail';
  return 'seat-detail__activity-item';
}
