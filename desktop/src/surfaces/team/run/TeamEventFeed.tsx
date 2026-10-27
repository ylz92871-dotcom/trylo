import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ArrowRightLeft, ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AnswerLink } from '../../../components/chat/AnswerLink';
import type { ConversationTimelineEnvironment } from '../../../components/chat/ConversationPresentation';
import type { ChatMessage } from '../../../components/chat/types';
import { createFollowController } from '../../../components/chat/follow-controller';
import type { TeamHandoffRecord, TeamProgressReport } from '../../../domain/team-progress';
import type { TeamRun } from '../team-types';
import { reportHistory } from '../team-progress-projection';
import { TeamMark } from './TeamMark';
import { findMember, handoffSender, handoffState, memberName, memberState, shortText, timeLabel } from './team-presentation';

export function HandoffSummary({ run, handoff, onOpen }: {
  readonly run: TeamRun; readonly handoff: TeamHandoffRecord; readonly onOpen: (id: string) => void;
}): ReactElement {
  const from = handoffSender(run, handoff);
  const to = findMember(run, handoff.toSeatId, handoff.toMemberId);
  return <button className="team-handoff" onClick={() => onOpen(handoff.id)} aria-label={`查看${from}交给${to ? memberName(to) : '历史成员'}的工作消息`}>
    <ArrowRightLeft size={15} /><span><span className="team-handoff__top">{from} → {to ? memberName(to) : '历史成员'}<small>{timeLabel(handoff.settledAt ?? handoff.at)} {handoffState(handoff)}</small></span>
      <span className="team-handoff__message">{shortText(handoff.message.replace(/\s+/g, ' '), 130)}</span></span><ChevronRight size={13} />
  </button>;
}

function ReportBody({ text, environment }: { readonly text: string; readonly environment?: ConversationTimelineEnvironment }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 900;
  return <><div className={`team-report__body${long && !expanded ? ' team-report__body--collapsed' : ''}`}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <AnswerLink href={href} {...environment}>{children}</AnswerLink> }}>{text}</ReactMarkdown></div>
    {long && <button className="team-text-action" onClick={() => setExpanded(value => !value)}>{expanded ? '收起汇报' : '展开完整汇报'}</button>}</>;
}

export function TeamEventFeed({ run, personMessages = [], environment, onSelectSeat, onOpenHandoff }: {
  readonly run: TeamRun; readonly personMessages?: readonly ChatMessage[];
  readonly environment?: ConversationTimelineEnvironment;
  readonly onSelectSeat: (id: string) => void; readonly onOpenHandoff: (id: string) => void;
}): ReactElement {
  const history = useMemo(() => reportHistory(run).filter(report => ['progress', 'blocked', 'ready', 'error'].includes(report.kind)), [run]);
  const items = useMemo(() => {
    const result: ({ kind: 'report'; report: TeamProgressReport; at?: number; key: string }
      | { kind: 'handoff'; handoff: TeamHandoffRecord; at: number; key: string }
      | { kind: 'person'; message: Extract<ChatMessage, { kind: 'text' }>; at: number; key: string }
      | { kind: 'event'; message: ChatMessage; at: number; key: string })[] =
      history.map(report => ({ kind: 'report', report, at: report.at, key: report.id }));
    for (const handoff of run.handoffs ?? []) result.push({ kind: 'handoff', handoff, at: handoff.at, key: `handoff:${handoff.id}` });
    for (const message of personMessages) if (message.kind === 'text' && message.role !== 'system' && message.text.trim()
      && message.createdAt >= run.createdAt) result.push({ kind: 'person', message, at: message.createdAt, key: `person:${message.id}` });
    // Actionable questions, errors and deliverables retain the personal
    // renderer and callbacks. Pending approvals remain in the existing rail.
    for (const message of personMessages) if (['input_request', 'error', 'artifact', 'task_suggestion', 'cognition_prompt',
      'learning_impact', 'compaction', 'work_narration', 'deliverable'].includes(message.kind)
      && message.createdAt >= run.createdAt) result.push({ kind: 'event', message, at: message.createdAt, key: `event:${message.id}` });
    return result.sort((a, b) => a.at === undefined || b.at === undefined ? 0 : a.at - b.at);
  }, [history, run.handoffs, personMessages, run.createdAt]);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(createFollowController());
  const [away, setAway] = useState(false);
  const touch = useRef(0);
  const pin = useCallback((): void => {
    const node = scroll.current;
    if (!node) return;
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    follow.current.sync({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight });
  }, []);
  useLayoutEffect(() => { if (follow.current.isFollowing()) pin(); else setAway(true); }, [items, pin]);
  return <div className="team-feed">
    <div className="team-feed__scroll" ref={scroll} tabIndex={0} aria-label="团队事件流"
      onWheel={event => { if (event.deltaY < 0) follow.current.pause(); }}
      onTouchStart={event => { touch.current = event.touches[0]?.clientY ?? 0; }}
      onTouchMove={event => { const y = event.touches[0]?.clientY ?? touch.current; if (y > touch.current) follow.current.pause(); touch.current = y; }}
      onKeyDown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) follow.current.pause(); }}
      onScroll={event => { const node = event.currentTarget; follow.current.observe({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }); if (follow.current.isFollowing()) setAway(false); }}>
      <div className="team-feed__content">
        {items.length === 0 && <p className="team-feed__empty">{run.lifecycle === 'closed' ? '这份历史没有独立的进展汇报。原始任务与完整答复保留在各成员会话中。' : '成员的进展汇报会在这里追加。点击下方成员，可以查看完整执行过程。'}</p>}
        {items.map(item => {
          if (item.kind === 'handoff') return <HandoffSummary key={item.key} run={run} handoff={item.handoff} onOpen={onOpenHandoff} />;
          if (item.kind === 'event') return <div className="team-feed__event" key={item.key}>{environment?.renderEvent?.(item.message)}</div>;
          if (item.kind === 'person') return <article key={item.key} className={`team-report${item.message.role === 'user' ? ' team-report--user' : ''}`}>
            {item.message.role !== 'user' && <TeamMark role="personal" />}<div><div className="team-report__meta"><strong>{item.message.role === 'user' ? '你' : 'Person'}</strong><time>{timeLabel(item.at)}</time></div><ReportBody text={item.message.text} environment={environment} /></div></article>;
          const { report } = item;
          const seat = findMember(run, report.seatId, report.memberId);
          const name = seat ? memberName(seat) : run.frozenProfile.members.find(member => member.memberId === report.memberId)?.displayName ?? '历史成员';
          return <article className={`team-report${report.kind === 'error' ? ' team-report--error' : ''}`} key={item.key} data-report-id={report.id}>
            {seat ? <button className="team-avatar-button" onClick={() => onSelectSeat(seat.id)} aria-label={`查看${name}的当前工作`}><TeamMark role={seat.seat} /></button> : <span />}
            <div><div className="team-report__meta">{seat ? <button onClick={() => onSelectSeat(seat.id)} className="team-report__author" aria-label={`查看${name}的执行过程`}>{name}<ChevronRight size={12} /></button> : <strong>{name}</strong>}
              {report.kind === 'blocked' && <span>遇到阻碍</span>}{report.kind === 'ready' && <span>待接续</span>}<time>{timeLabel(report.at)}</time></div>
              <ReportBody text={report.text} environment={environment} />{report.streaming && <span className="team-report__streaming" role="status">正在汇报…</span>}
            </div></article>;
        })}
        {away && <button className="team-feed__latest" onClick={() => { follow.current.rearm(); pin(); setAway(false); }}>查看最新进展 ↓</button>}
      </div>
    </div>
    <div className="team-feed__activity" aria-label="当前成员状态">{run.seats.slice(0, 6).map(seat => <button key={seat.id} onClick={() => onSelectSeat(seat.id)}>{memberName(seat)} · {memberState(seat)}</button>)}</div>
  </div>;
}
