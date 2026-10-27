import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Network, MessagesSquare, Users } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ConversationPresentation, type ConversationTimelineEnvironment } from '../../../components/chat/ConversationPresentation';
import { TEAM_STATUS_LABEL } from '../../shared/status';
import { SeatDetail } from '../SeatDetail';
import type { TeamRun } from '../team-types';
import { isTeamRunActive } from '../team-store';
import type { SendSubagentInput } from '../../../host-adapter/subagent-contract';
import { HandoffSummary, TeamEventFeed } from './TeamEventFeed';
import { TeamMark } from './TeamMark';
import { TeamGraph } from './TeamGraph';
import { currentTask, findMember, handoffSender, handoffState, memberName, memberState, timeLabel } from './team-presentation';

export interface TeamRunViewProps {
  readonly personView?: ReactNode;
  readonly approvals?: ReactNode;
  readonly memberDrafts?: Map<string, string>;
  readonly onMemberInput?: SendSubagentInput;
  readonly run: TeamRun;
  readonly onStopRun?: () => void;
  readonly onNewTeam?: () => void;
  readonly onSelectSeat: (seatId: string | null) => void;
  readonly onCancelSeat?: (seatId: string) => void;
  readonly onOpenPerson?: () => void;
}

type View = 'feed' | 'map';
const storageKey = 'trylo:team:workspace-layout:v1';
function readPreference(): { view: View; feed: number; map: number } {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, unknown>;
    const ratio = (key: string, fallback: number): number => {
      const number = value[key];
      return typeof number === 'number' && Number.isFinite(number) ? Math.max(.2, Math.min(.75, number)) : fallback;
    };
    return { view: value.view === 'map' ? 'map' : 'feed', feed: ratio('feed', .48), map: ratio('map', .36) };
  } catch { return { view: 'feed', feed: .48, map: .36 }; }
}

export function TeamRunView(props: TeamRunViewProps): ReactElement {
  const { run } = props;
  const preference = useRef(readPreference());
  const [view, setView] = useState<View>(preference.current.view);
  const [mobilePane, setMobilePane] = useState<'person' | 'team'>('person');
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const [leftWidth, setLeftWidth] = useState<number | undefined>();
  const [ratioNow, setRatioNow] = useState(36);
  const workspace = useRef<HTMLDivElement>(null);
  const person = useRef<HTMLDivElement>(null);
  const drafts = useRef(new Map<string, string>());
  const environment = useRef<ConversationTimelineEnvironment>({});
  const observeEnvironment = useCallback((value: ConversationTimelineEnvironment): void => { environment.current = value; }, []);
  const drag = useRef<number | null>(null);
  const hasActive = isTeamRunActive(run);
  const connected = run.recovery === undefined;
  const displayStatus = hasActive && ['completed', 'failed', 'cancelled'].includes(run.status) ? 'running' : run.status;
  const selected = run.seats.find(seat => seat.id === run.selectedSeatId);
  const handoff = run.handoffs?.find(item => item.id === handoffId);
  const lastProgressAt = Math.max(run.createdAt, ...run.seats.flatMap(seat => [seat.startedAt ?? 0, seat.endedAt ?? 0,
    ...(seat.activity ?? []).map(item => item.at)]), ...(run.reports ?? []).map(report => report.at ?? 0),
    ...(run.handoffs ?? []).map(item => item.settledAt ?? item.at));
  const split = view === 'map' || selected !== undefined || handoff !== undefined;
  const persist = useCallback((): void => { try { localStorage.setItem(storageKey, JSON.stringify(preference.current)); } catch { /* layout can remain session-only */ } }, []);
  const resize = useCallback((requested?: number): void => {
    const width = workspace.current?.clientWidth ?? 0;
    if (width < 780) return;
    const min = view === 'map' ? 320 : 360;
    const max = Math.max(min, width - 8 - (view === 'map' ? 460 : 420));
    const pixels = Math.round(Math.min(max, Math.max(min, requested ?? preference.current[view] * (width - 8))));
    setLeftWidth(pixels); setRatioNow(Math.round(pixels / (width - 8) * 100));
    if (requested !== undefined) preference.current[view] = pixels / (width - 8);
  }, [view]);
  useLayoutEffect(() => {
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => resize());
    if (workspace.current) observer?.observe(workspace.current);
    const onResize = (): void => resize();
    window.addEventListener('resize', onResize);
    return () => { observer?.disconnect(); window.removeEventListener('resize', onResize); };
  }, [resize, split]);
  useEffect(() => { setHandoffId(null); }, [run.id]);
  const chooseMember = (id: string): void => { setHandoffId(null); setMobilePane('team'); props.onSelectSeat(id); };
  const openHandoff = (id: string): void => { setHandoffId(id); setMobilePane('team'); };
  const back = (): void => { if (handoffId) setHandoffId(null); else props.onSelectSeat(null); if (view === 'feed') setMobilePane('person'); };
  const focusPerson = (): void => { setView('map'); setMobilePane('person'); requestAnimationFrame(() => person.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()); };
  const changeView = (next: View): void => { setView(next); preference.current.view = next; persist(); setMobilePane(next === 'map' ? 'team' : 'person'); };
  const closeMenus = (): void => { workspace.current?.parentElement?.querySelectorAll('details.team-menu[open]').forEach(menu => menu.removeAttribute('open')); };
  const renderFeed = (messages?: readonly import('../../../components/chat/types').ChatMessage[], environment?: ConversationTimelineEnvironment): ReactElement =>
    <TeamEventFeed run={run} personMessages={messages} environment={environment} onSelectSeat={chooseMember} onOpenHandoff={openHandoff} />;
  const recoveryLabels = { checking: '核对中', detached: '未连接', unavailable: '待核实' };
  return <div className="team-run" data-view={view} onKeyDown={event => {
    if (event.key !== 'Escape') return;
    if (event.currentTarget.querySelector('details.team-menu[open]')) { closeMenus(); event.preventDefault(); }
    else if (handoff || selected) { back(); event.preventDefault(); }
  }}>
    <header className="team-run__head" aria-label="团队视图与操作">
        <div className="team-view-tabs" role="tablist" aria-label="团队视图">{(['feed', 'map'] as const).map((item, index) => <button key={item} role="tab" aria-selected={view === item}
          onClick={() => changeView(item)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); changeView(item === 'feed' ? 'map' : 'feed'); const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]'); tabs?.[1 - index]?.focus(); } }}>
          {item === 'feed' ? <MessagesSquare size={14} /> : <Network size={14} />}{item === 'feed' ? '事件流' : '团队架构'}</button>)}</div>
      <div className="team-run__head-actions">
        <span className={`team-run__state team-run__state--${displayStatus}`}>{run.recovery ? recoveryLabels[run.recovery.kind] : TEAM_STATUS_LABEL[displayStatus]}</span>
        <details className="team-menu"><summary aria-label="查看所有成员及当前任务" title="成员与团队操作"><Users size={15} /><span>成员 {run.seats.length}</span><ChevronDown size={12} /></summary>
          <div className="team-menu__popup">{run.seats.map(seat => <button key={seat.id} className="team-roster-member" onClick={() => { closeMenus(); chooseMember(seat.id); }}>
            <TeamMark role={seat.seat} size={21} /><span><strong>{memberName(seat)}</strong><small>{currentTask(seat)}</small></span><em>{memberState(seat)}</em></button>)}
            {(props.onOpenPerson || (hasActive && props.onStopRun) || (!hasActive && props.onNewTeam)) && <div className="team-menu__actions">
              {props.onOpenPerson && <button onClick={() => { closeMenus(); props.onOpenPerson?.(); }}>打开完整 Person 对话</button>}
              {hasActive && props.onStopRun && <button onClick={() => { closeMenus(); props.onStopRun?.(); }}>停止</button>}
              {!hasActive && props.onNewTeam && <button onClick={() => { closeMenus(); props.onNewTeam?.(); }}>新团队</button>}
            </div>}
          </div></details>
      </div>
    </header>
    {(run.recovery || run.error) && <p className="team-run__recovery" role={run.error ? 'alert' : 'status'}>{run.recovery?.message ?? run.error}</p>}
    {props.approvals && <div className="team-run__approvals">{props.approvals}</div>}
    {split && <div className="team-mobile-tabs" aria-label="查看区域"><button aria-pressed={mobilePane === 'person'} onClick={() => setMobilePane('person')}>{view === 'map' ? 'Person' : '事件流'}</button><button aria-pressed={mobilePane === 'team'} onClick={() => setMobilePane('team')}>团队</button></div>}
    <div className="team-workspace" ref={workspace} data-split={split} data-view={view} data-mobile-pane={mobilePane}
      style={{ '--team-left': leftWidth === undefined ? `${view === 'map' ? 36 : 48}%` : `${leftWidth}px` } as CSSProperties}>
      <ConversationPresentation.Provider value={{ embedded: true, observeEnvironment, ...(view === 'feed' ? { timeline: renderFeed } : {}) }}>
        <section className="team-workspace__person" ref={person} aria-label={view === 'map' ? '与 Person 的对话' : '团队汇报与 Person 输入'}>
          {view === 'map' && <div className="team-person-heading"><TeamMark role="personal" size={23} /><strong>Person</strong><span>与你协调这项任务</span></div>}
          {props.personView ?? <>{renderFeed()}{props.onOpenPerson && <button className="team-fallback-person" onClick={props.onOpenPerson}>回到 Person 继续对话 <ChevronRight size={14} /></button>}</>}
        </section>
      </ConversationPresentation.Provider>
      {split && <div className="team-splitter" role="separator" tabIndex={0} aria-label="调整左右区域宽度，双击恢复" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratioNow}
        onPointerDown={event => { if (event.button !== 0) return; drag.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
        onPointerMove={event => { if (drag.current === event.pointerId && workspace.current) resize(event.clientX - workspace.current.getBoundingClientRect().left); }}
        onPointerUp={() => { drag.current = null; persist(); }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
        onDoubleClick={() => { preference.current[view] = view === 'map' ? .36 : .48; resize(); persist(); }}
        onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); resize(event.key === 'Home' ? 0 : event.key === 'End' ? Number.MAX_SAFE_INTEGER : (leftWidth ?? 360) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 48 : 16)); persist(); }}><span /></div>}
      {split && <section className="team-workspace__team" aria-label="团队架构和成员会话">
        {handoff ? <><header className="team-detail-head"><strong>工作交接</strong><button className="team-icon-button" aria-label="返回" onClick={back}><ArrowLeft size={17} /></button></header>
          <div className="team-handoff-detail"><h3>{handoffSender(run, handoff)} → {findMember(run, handoff.toSeatId, handoff.toMemberId) ? memberName(findMember(run, handoff.toSeatId, handoff.toMemberId)!) : '历史成员'}</h3>
            <p className="team-detail-meta">{timeLabel(handoff.at)} 发出 · {handoffState(handoff)}{handoff.settledAt ? ` ${timeLabel(handoff.settledAt)}` : ''}</p>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{handoff.message}</ReactMarkdown>
            {handoff.error && <p role="alert">{handoff.error}</p>}
            <p className="team-detail-meta">此处展示实际投递回执，执行进展在接收成员的会话中更新。</p>
            {findMember(run, handoff.toSeatId, handoff.toMemberId) && <button className="team-text-action" onClick={() => chooseMember(findMember(run, handoff.toSeatId, handoff.toMemberId)!.id)}>查看接收成员的会话 <ChevronRight size={13} /></button>}
          </div></> : selected ? <SeatDetail embedded seat={connected ? selected : { ...selected, canReceiveInput: false }}
            observing={connected}
            onOpenArtifact={environment.current.onOpenArtifact} artifactHost={environment.current.artifactHost} workspacePath={environment.current.workspacePath}
            conversationKey={`${run.id}:${selected.memberId ?? selected.id}`} drafts={props.memberDrafts ?? drafts.current}
            onMemberInput={run.lifecycle === 'closed' || !connected ? undefined : props.onMemberInput} onBack={back}
            onOpenPerson={focusPerson} {...(props.onCancelSeat && connected ? { onCancel: props.onCancelSeat } : {})} />
          : <><div className="team-graph-heading"><span>分工与当前进展</span><time>更新于 {timeLabel(lastProgressAt)}</time></div><TeamGraph run={run} onSelect={chooseMember} onPerson={focusPerson} />
            {run.handoffs?.length ? <div className="team-graph-handoff"><HandoffSummary run={run} handoff={run.handoffs[run.handoffs.length - 1]!} onOpen={openHandoff} /></div> : null}</>}
      </section>}
    </div>
  </div>;
}
