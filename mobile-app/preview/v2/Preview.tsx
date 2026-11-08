import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useId, type ReactNode } from 'react';
import { RemoteGatewayClient, type RemoteSnapshot, type GatewayConnectionState, type RemoteChatMessage, type RemoteArtifact } from '../../src/gateway';
import { Icon, Mark } from './icons';
import InlineProcess from './InlineProcess';
import './style.css';

const client = new RemoteGatewayClient({ baseUrl: 'http://127.0.0.1:49424', token: 'trylo-mobile-v2-preview-synthetic-20261015', demo: false });
type View = 'sessions' | 'conversation' | 'inbox' | 'devices';
type Pane = 'chat' | 'activity' | 'results';
type DisplayMode = 'dialogue' | 'process';
const MODE_KEY = 'trylo.preview.remote.view-mode.v1';
function readMode(): DisplayMode {
  try { return localStorage.getItem(MODE_KEY) === 'dialogue' ? 'dialogue' : 'process'; } catch { return 'process'; }
}
type Sheet = { kind: 'approval' | 'device' | 'help' | 'new' | 'stop' } | { kind: 'tool'; message: RemoteChatMessage } | { kind: 'artifact'; artifact: RemoteArtifact };
type Remote = { snapshot: RemoteSnapshot | null; ready: boolean; state: GatewayConnectionState; receivedAt: number; pending: boolean; error: string; artifacts: RemoteArtifact[]; paused: boolean; reconnect: () => void; pause: () => void; perform: (operation: () => Promise<unknown>) => Promise<boolean> };
const RemoteContext = createContext<Remote>(null!);
const useRemote = () => useContext(RemoteContext);
const statusOf = (snapshot: RemoteSnapshot | null) => !snapshot ? '等待同步' : snapshot.approvals.length ? '需要确认' : snapshot.agent.phase === 'stopped' ? '已停止' : snapshot.agent.status === 'done' ? '已完成' : snapshot.agent.status === 'failed' ? '执行失败' : snapshot.agent.status === 'idle' ? '就绪' : '进行中';
const activeTool = (m: RemoteChatMessage) => m.role === 'thinking' || m.role === 'tool';
const timeLabel = (value: string | number) => { const age = Date.now() - Number(value); return age < 3600000 ? '刚刚' : age < 86400000 ? '今天' : '昨天'; };
const toolTarget = (message: RemoteChatMessage) => { try { const input = JSON.parse(message.input || '{}'); return String(input.path || input.file_path || input.command || ''); } catch { return message.input || ''; } };
const toolState = (message: RemoteChatMessage) => message.status === 'streaming' ? '进行中' : message.status === 'interrupted' ? '已中断' : message.status === 'error' ? '失败' : '已完成';

function SheetPanel({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    node.querySelector<HTMLElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (!node.contains(document.activeElement)) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const focusable = [...node.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], textarea:not(:disabled), [tabindex="0"]')];
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="v2-sheet-layer"><button className="v2-scrim" onClick={onClose} aria-label="关闭面板" tabIndex={-1}/><div ref={ref} className="v2-sheet" role="dialog" aria-modal="true" aria-labelledby={id}><div className="v2-sheet-grip"/><header><h2 id={id}>{title}</h2><button className="v2-icon" aria-label="关闭" onClick={onClose}><Icon name="close"/></button></header><div className="v2-sheet-content">{children}</div>{footer && <div className="v2-sheet-footer">{footer}</div>}</div></div>;
}

function Phone({ start = 'conversation', companion = false }: { start?: View; companion?: boolean }) {
  const { snapshot, ready, state, pending, error, artifacts, receivedAt, reconnect } = useRemote();
  const [view, setView] = useState<View>(start);
  const [pane, setPane] = useState<Pane>('chat');
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => companion ? 'dialogue' : readMode());
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [filter, setFilter] = useState('all');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedTurn, setSelectedTurn] = useState<string | undefined>();
  const [artifactText, setArtifactText] = useState('');
  const [fileError, setFileError] = useState('');
  const [following, setFollowing] = useState(true);
  const feed = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const viewPositions = useRef<Record<string, { top: number; follow: boolean }>>({});
  const { perform } = useRemote();
  const session = snapshot?.sessions.find(s => s.id === snapshot.activeSessionId);
  const sessionId = snapshot?.activeSessionId || 'pending';
  const positionKey = `${sessionId}:${displayMode}:${pane}`;
  const draft = drafts[sessionId] || '';
  const conversation = snapshot?.conversation || [];
  const approval = snapshot?.approvals[0];
  const label = statusOf(snapshot);
  const filteredSessions = snapshot?.sessions.filter(s => filter === 'all' || s.id === sessionId && (filter === 'waiting' ? !!approval : !['idle', 'done', 'failed'].includes(snapshot.agent.status) && snapshot.agent.phase !== 'stopped')) || [];
  const currentTurn = [...conversation].reverse().find(m => m.turnId)?.turnId;
  const processes = conversation.filter(m => activeTool(m) && (!selectedTurn && !currentTurn || m.turnId === (selectedTurn || currentTurn)));
  const tools = processes.filter(m => m.role === 'tool');
  const busy = !!snapshot && !['idle', 'done', 'failed'].includes(snapshot.agent.status) && snapshot.agent.phase !== 'stopped';
  const offlineText = state === 'offline' ? '连接已断开' : state === 'reconnecting' ? '正在恢复连接' : '正在同步会话';
  const connectionText = ready ? '已同步' : state === 'offline' ? '离线' : '同步中';
  useEffect(() => { if (sheet?.kind === 'approval' && snapshot && !snapshot.approvals.length) setSheet(null); }, [snapshot?.approvals.length]);
  useLayoutEffect(() => {
    if (!feed.current) return;
    const position = viewPositions.current[positionKey];
    followRef.current = position?.follow ?? true;
    setFollowing(followRef.current);
    feed.current.scrollTop = position?.top ?? (pane === 'chat' ? feed.current.scrollHeight : 0);
  }, [positionKey, view]);
  useEffect(() => {
    if (followRef.current && feed.current && pane === 'chat') feed.current.scrollTop = feed.current.scrollHeight;
  }, [conversation, following, pane, displayMode]);
  useEffect(() => {
    setSelectedTurn(undefined);
  }, [sessionId]);
  useEffect(() => {
    let cancelled = false;
    if (sheet?.kind !== 'artifact') return;
    setArtifactText(''); setFileError('');
    void client.getArtifactContent(sheet.artifact.id).then(result => result.blob.text()).then(value => { if (!cancelled) setArtifactText(value); }).catch(cause => { if (!cancelled) setFileError(cause instanceof Error ? cause.message : '文件读取失败'); });
    return () => { cancelled = true; };
  }, [sheet]);
  const openSession = async (id: string) => {
    if (id === sessionId) { setView('conversation'); setPane('chat'); return; }
    if (await perform(() => client.selectSession(id))) { setView('conversation'); setPane('chat'); }
  };
  const create = async (surface: 'code' | 'work') => { if (await perform(() => client.createSession(surface))) { setSheet(null); setView('conversation'); setPane('chat'); } };
  const send = async () => {
    if (!draft.trim()) return;
    const sent = draft;
    if (await perform(() => client.sendChat(sent.trim(), undefined, { surface: session?.surface || 'code' }))) {
      setDrafts(current => ({ ...current, [sessionId]: current[sessionId] === sent ? '' : current[sessionId] }));
      followRef.current = true; setFollowing(true);
    }
  };
  const rememberPosition = () => {
    if (feed.current) viewPositions.current[positionKey] = { top: feed.current.scrollTop, follow: followRef.current };
  };
  const changeMode = (mode: DisplayMode) => {
    rememberPosition();
    setDisplayMode(mode); setPane('chat');
    if (!companion) { try { localStorage.setItem(MODE_KEY, mode); } catch { /* Reading remains available without storage. */ } }
  };
  const reviewGroup = (messages: RemoteChatMessage[]) => {
    const groupTools = messages.filter(m => m.role === 'tool');
    const done = groupTools.filter(m => m.status === 'done').length;
    return <button className="v2-process-summary" onClick={() => { rememberPosition(); setSelectedTurn(messages[0]?.turnId); setPane('activity'); }}><span className="v2-process-mark"><Icon name="activity" size={17}/></span><span><strong>查看执行过程</strong><small>{groupTools.length ? `${done} 项操作已完成` : '查看思考摘要'}{groupTools.some(m => m.status === 'streaming') ? `，${groupTools.filter(m => m.status === 'streaming').length} 项未完成` : ''}</small></span><Icon name="chevron" size={15}/></button>;
  };
  const thread: ReactNode[] = [];
  for (let i = 0; i < conversation.length; i++) {
    const message = conversation[i];
    if (activeTool(message)) {
      if (displayMode === 'process') {
        thread.push(<InlineProcess key={message.id} message={message} open={!!expandedEvents[message.id]} onOpen={open => setExpandedEvents(current => current[message.id] === open ? current : { ...current, [message.id]: open })}/>);
        continue;
      }
      const group = [message];
      while (i + 1 < conversation.length && activeTool(conversation[i + 1])) group.push(conversation[++i]);
      thread.push(<div key={message.id}>{reviewGroup(group)}</div>);
    } else if (message.role === 'user') thread.push(<div className="v2-user" key={message.id}>{message.text}</div>);
    else thread.push(<article className="v2-assistant" key={message.id}><div className="v2-assistant-label"><Mark/><span>Trylo</span></div>{message.text.split('\n').filter(Boolean).map((line, i) => <p key={i}>{line}</p>)}</article>);
  }
  const nav = <nav className="v2-navigation" aria-label="远程工作台导航">{(['sessions','inbox','devices'] as const).map((item, i) => <button key={item} aria-current={view === item ? 'page' : undefined} onClick={() => { setView(item); setSheet(null); }}><span><Icon name={['message','inbox','desktop'][i]}/>{item === 'inbox' && approval && <i/>}</span>{['会话','待处理','设备'][i]}</button>)}</nav>;
  return <section className={`v2-demo-column${companion ? ' v2-companion' : ''}`}><div className="v2-stage-label"><strong>{displayMode === 'dialogue' ? '对话模式' : '过程模式'}</strong><span>{displayMode === 'dialogue' ? '专注回复，过程按需查看' : '逐项呈现，跟进执行细节'}</span></div><div className="v2-phone"><div className="v2-app">
    <div className="v2-app-content" inert={!!sheet}>
    {view === 'conversation' ? <>
      <header className="v2-conversation-header"><div className="v2-titlebar"><button className="v2-icon" aria-label="返回会话列表" onClick={() => setView('sessions')}><Icon name="back"/></button><div><h1>{session?.title || '远程会话'}</h1><span>{session?.surface === 'work' ? 'Work' : 'Code'} <i/> Trylo</span></div><button className="v2-icon" aria-label="查看会话与设备" onClick={() => setSheet({kind:'device'})}><Icon name="more"/></button></div><button className={`v2-connection ${!ready ? 'is-offline' : ''}`} onClick={() => setSheet({kind:'device'})}><Icon name="desktop" size={13}/><span>{snapshot?.device.name || '开发电脑'}</span><span><i/>{connectionText}</span><Icon name="chevron" size={12}/></button></header>
      {!ready && <div className="v2-recovery" role="status"><Icon name="retry" size={15}/><span>{offlineText}，已保留内容和草稿。</span><button onClick={reconnect}>重试</button></div>}
      <div className="v2-viewbar"><div className="v2-mode-switch" role="group" aria-label="事件流展示模式">{(['dialogue','process'] as const).map(mode => <button key={mode} aria-pressed={displayMode === mode} onClick={() => changeMode(mode)}>{mode === 'dialogue' ? '对话模式' : '过程模式'}</button>)}</div><button className={`v2-result-entry${pane === 'results' ? ' selected' : ''}`} aria-pressed={pane === 'results'} onClick={() => { rememberPosition(); setPane(pane === 'results' ? 'chat' : 'results'); }}><Icon name="file" size={14}/>结果{artifacts.length > 0 && <small>{artifacts.length}</small>}</button></div>
      <div className={`v2-feed v2-feed-${pane} v2-mode-${displayMode}`} role="region" aria-label={pane === 'chat' ? displayMode === 'process' ? '完整事件流' : '对话内容' : pane === 'activity' ? '执行记录' : '项目结果'} ref={feed} onScroll={() => { const e=feed.current; if (e) { const follow=e.scrollHeight-e.scrollTop-e.clientHeight < 70; followRef.current=follow; setFollowing(follow); viewPositions.current[positionKey]={top:e.scrollTop,follow}; } }}>
        {pane === 'chat' && <>{conversation.length ? <><div className="v2-day">今天</div>{thread}</> : <div className="v2-empty"><Mark/><h2>从这里继续工作</h2><p>消息会发送到电脑，过程和结果同步到这段会话。</p></div>}{snapshot?.agent.status === 'done' && <div className="v2-finish"><Icon name="check" size={14}/>任务已完成</div>}{snapshot?.agent.phase === 'stopped' && <div className="v2-finish"><Icon name="stop" size={14}/>电脑已停止本次任务</div>}</>}
        {pane === 'activity' && <><button className="v2-back-to-thread" onClick={() => { rememberPosition(); setPane('chat'); }}><Icon name="back" size={14}/>返回对话</button><div className="v2-section-head"><h2>执行记录</h2><span>{tools.filter(m=>m.status==='done').length} / {tools.length} 项完成</span></div><p className="v2-description">由电脑同步的思考摘要与工具操作。</p><div className="v2-log-list">{processes.map(message => <button className="v2-log" key={message.id} onClick={() => setSheet({kind:'tool',message})}><span className={`v2-log-symbol ${message.status === 'streaming' ? 'waiting' : ''}`}><Icon name={message.role === 'thinking' ? 'activity' : message.status === 'streaming' ? 'clock' : 'check'} size={17}/></span><span><strong>{message.title || '思考摘要'}</strong><small>{message.role === 'thinking' ? '思考摘要' : toolTarget(message)}</small><em className={message.status === 'streaming' ? 'waiting' : ''}>{message.role === 'thinking' ? '展开查看' : toolState(message)}{message.durationMs != null ? ` · ${(message.durationMs/1000).toFixed(2)} 秒` : ''}</em></span><Icon name="chevron" size={15}/></button>)}</div>{!processes.length && <div className="v2-empty"><Icon name="activity" size={32}/><h2>还没有执行记录</h2><p>任务开始后，电脑的执行过程会显示在这里。</p></div>}</>}
        {pane === 'results' && <><div className="v2-section-head"><h2>项目文件</h2><span>{artifacts.length} 个文件</span></div><p className="v2-description">查看电脑在当前项目中生成的结果。</p>{artifacts.map(file => <button className="v2-file" key={file.id} disabled={!ready || pending} onClick={() => setSheet({kind:'artifact',artifact:file})}><span><Icon name="file" size={23}/></span><span><strong>{file.name}</strong><small>Markdown 文档 · {Math.max(1,Math.ceil(file.size/1024))} KB</small></span><Icon name="chevron" size={16}/></button>)}{!artifacts.length && <div className="v2-empty"><Icon name="file" size={34}/><h2>结果会留在这里</h2><p>{approval ? '处理当前确认后，电脑会继续执行并整理检查记录。' : '电脑生成的文件将显示在这里。'}</p></div>}</>}
      </div>
      {pane === 'chat' && !following && <button className="v2-jump" onClick={()=>{followRef.current=true;setFollowing(true);}}>回到最新消息 <Icon name="down" size={13}/></button>}
      <div className="v2-conversation-bottom">
        {approval ? <button className="v2-attention" onClick={() => setSheet({kind:'approval'})}><Icon name="shield" size={18}/><span><strong>需要你确认</strong><small>{approval.title}</small></span><b>查看</b><Icon name="chevron" size={14}/></button> : <div className="v2-run-line"><span><i className={ready ? 'online' : ''}/>{ready ? label : '等待恢复同步'}</span>{busy && <button disabled={!ready||pending} onClick={()=>setSheet({kind:'stop'})}><Icon name="stop" size={13}/>停止</button>}</div>}
        {error && <p className="v2-error" role="alert">{error}</p>}
        <form className="v2-composer" onSubmit={e=>{e.preventDefault();void send();}}><textarea rows={2} aria-label="发送到电脑的消息" placeholder={ready ? '让电脑继续做点什么…' : '连接恢复后继续，草稿会保留'} value={draft} onChange={e=>setDrafts(current=>({...current,[sessionId]:e.target.value}))}/><div><span><Icon name="desktop" size={12}/>{session?.surface === 'work' ? 'Work' : 'Code'}<small>在电脑上执行</small></span><button aria-label="发送消息" className="v2-send" disabled={!ready||pending||!draft.trim()||!!approval}><Icon name="arrow" size={19}/></button></div></form><div className="v2-safe-area"/>
      </div>
    </> : <>
      <header className="v2-home-header"><div className="v2-brand"><Mark/><span>Trylo</span><span className="v2-remote-label">远程</span></div><button className="v2-icon" aria-label="新建远程会话" disabled={!ready||pending} onClick={()=>setSheet({kind:'new'})}><Icon name="add" size={23}/></button></header>
      <div className="v2-home-scroll">
      {view === 'sessions' && <><div className="v2-home-title"><h1>会话</h1><button onClick={()=>setView('devices')} className={`v2-home-connection ${!ready?'offline':''}`}><i/>{ready?'电脑在线':connectionText}<Icon name="chevron" size={12}/></button></div><button className="v2-workspace" onClick={()=>setSheet({kind:'device'})}><span className="v2-workspace-icon"><Icon name="folder" size={20}/></span><span><strong>Trylo</strong><small>{snapshot?.device.name || '开发电脑'}</small></span><Icon name="chevron" size={16}/></button>
      {!!approval && <button className="v2-home-attention" onClick={()=>setView('inbox')}><span className="v2-attention-icon"><Icon name="inbox" size={19}/></span><span><strong>有 1 项操作需要你确认</strong><small>处理后，电脑会继续当前任务</small></span><Icon name="chevron" size={16}/></button>}
      <div className="v2-filter" role="group" aria-label="筛选会话">{[['all','全部'],['active','进行中'],['waiting','待处理']].map(([key,title])=><button key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{title}{key==='waiting'&&approval&&<small>1</small>}</button>)}</div>
      <div className="v2-session-list">{filteredSessions.map(s=><button className="v2-session" key={s.id} disabled={!ready||pending} onClick={()=>void openSession(s.id)}><div className="v2-session-line"><span className="v2-surface">{s.surface==='work'?'Work':'Code'}</span>{s.id===sessionId&&<span className={`v2-session-status ${approval?'waiting':''}`}>{label}</span>}<time>{timeLabel(s.updatedAt)}</time></div><h2>{s.title}</h2><p>{s.id===sessionId&&approval?'连接配置已读取，等待确认后检查断线恢复。':s.preview||'开始一段新的远程对话'}</p><div className="v2-session-meta"><Icon name="folder" size={12}/>Trylo{s.id===sessionId&&<span>当前会话</span>}</div></button>)}</div>{!filteredSessions.length && <div className="v2-empty"><Icon name="check" size={29}/><h2>{filter === 'waiting' ? '没有等待确认的会话' : filter === 'active' ? '暂时没有进行中的会话' : '还没有远程会话'}</h2><p>可以开始一段新的对话，或查看全部会话。</p><button className="v2-text-button" onClick={()=>setFilter('all')}>查看全部会话</button></div>}<p className="v2-list-hint">会话与电脑保持同步，随时接着工作。</p></>}
      {view === 'inbox' && <><div className="v2-home-title"><h1>待处理</h1><span className="v2-count">{snapshot?.approvals.length || 0}</span></div><p className="v2-description">需要你确认后才能继续的操作。</p>{approval?<button className="v2-inbox-item" onClick={()=>setSheet({kind:'approval'})}><div><Icon name="shield" size={20}/><span>等待确认</span></div><h2>{approval.title}</h2><p>{session?.title}</p><code>{approval.detail}</code><span className="v2-inbox-action">查看操作 <Icon name="chevron" size={15}/></span></button>:<div className="v2-empty"><Icon name="check" size={34}/><h2>暂时没有待处理事项</h2><p>电脑需要你确认时，会在这里显示。</p><button className="v2-text-button" onClick={()=>setView('sessions')}>返回会话</button></div>}</>}
      {view === 'devices' && <><div className="v2-home-title"><h1>设备</h1></div><div className="v2-device-profile"><span><Icon name="desktop" size={32}/></span><h2>{snapshot?.device.name||'开发电脑'}</h2><p><i className={ready?'online':''}/>{ready?'连接正常，会话已同步':offlineText}</p></div><dl className="v2-facts"><div><dt>当前项目</dt><dd>Trylo</dd></div><div><dt>当前会话</dt><dd>{session?.title||'新会话'}</dd></div><div><dt>最近同步</dt><dd>{receivedAt?new Date(receivedAt).toLocaleTimeString('zh-CN',{hour12:false}):'等待连接'}</dd></div></dl><button className="v2-settings-row" onClick={()=>reconnect()}><Icon name="retry" size={19}/>重新连接<Icon name="chevron" size={16}/></button><button className="v2-settings-row" onClick={()=>setSheet({kind:'help'})}><Icon name="link" size={19}/>了解如何连接电脑<Icon name="chevron" size={16}/></button><p className="v2-list-hint">工作在电脑上运行。电脑需要保持开启，并允许远程连接。</p></>}
      </div>{nav}
    </>}
    </div>
    {sheet && <SheetPanel title={sheet.kind==='approval'?'确认电脑上的操作':sheet.kind==='tool'?sheet.message.title||'执行详情':sheet.kind==='artifact'?sheet.artifact.name:sheet.kind==='new'?'新建会话':sheet.kind==='stop'?'停止当前任务？':sheet.kind==='help'?'连接你的电脑':'会话与设备'} onClose={()=>setSheet(null)} footer={sheet.kind==='approval'?<><p className="v2-scope"><Icon name="shield" size={13}/>仅允许这一次操作</p><div className="v2-action-pair"><button disabled={!ready||pending||!approval} onClick={()=>void perform(()=>client.decidePermission(approval!.id,'deny'))}>拒绝</button><button className="primary" disabled={!ready||pending||!approval} onClick={()=>void perform(()=>client.decidePermission(approval!.id,'allow'))}>{pending?'正在提交…':'允许本次'}</button></div>{!ready&&<p className="v2-sheet-offline">连接恢复并同步后才能确认。</p>}</>:sheet.kind==='stop'?<div className="v2-action-pair"><button onClick={()=>setSheet(null)}>继续任务</button><button className="danger" disabled={!ready||pending} onClick={()=>void perform(()=>client.cancelCurrentTask()).then(ok=>{if(ok)setSheet(null);})}>{pending?'正在请求…':'停止任务'}</button></div>:undefined}>
      {sheet.kind==='approval'&&<><div className="v2-approval-context"><span className="v2-large-icon"><Icon name="terminal" size={23}/></span><div><strong>{approval?.title||'操作已处理'}</strong><small>{snapshot?.device.name} / Trylo</small></div></div><p className="v2-sheet-explanation">电脑正在等待你确认。允许后，这项检查会在当前项目继续运行。</p><div className="v2-command"><label>命令</label><code>{approval?.detail}</code><span>位置 <b>mobile-app</b></span></div><details className="v2-reason"><summary>为什么需要确认</summary><p>{approval?.description}</p></details>{error&&<p className="v2-error" role="alert">{error}</p>}</>}
      {sheet.kind==='tool'&&<><div className="v2-tool-state"><Icon name={sheet.message.status==='streaming'?'clock':'check'} size={16}/>{sheet.message.role==='thinking'?'思考摘要':toolState(sheet.message)}</div>{sheet.message.role==='thinking'?<p className="v2-sheet-explanation">{sheet.message.text}</p>:<>{sheet.message.input&&<><h3>输入</h3><pre>{(()=>{try{return JSON.stringify(JSON.parse(sheet.message.input!),null,2);}catch{return sheet.message.input;}})()}</pre></>}{sheet.message.output!==undefined?<><h3>结果</h3><pre>{sheet.message.output||'无文本输出'}</pre></>:<p className="v2-sheet-explanation">{sheet.message.status==='streaming'?'电脑尚未返回结果。':'电脑未提供文本结果。'}</p>}</>}</>}
      {sheet.kind==='artifact'&&<div className="v2-document">{fileError?<p role="alert">{fileError}</p>:artifactText?artifactText.split('\n').filter(Boolean).map((line,i)=>line.startsWith('# ')?<h3 key={i}>{line.slice(2)}</h3>:<p key={i}>{line.replace(/^- /,'• ')}</p>):<p role="status">正在读取文件…</p>}</div>}
      {sheet.kind==='device'&&<><div className="v2-sheet-computer"><Icon name="desktop" size={29}/><span><strong>{snapshot?.device.name||'开发电脑'}</strong><small>{ready?'当前会话已同步':offlineText}</small></span><i className={ready?'online':''}/></div><dl className="v2-facts"><div><dt>项目</dt><dd>Trylo</dd></div><div><dt>会话</dt><dd>{session?.title||'新会话'}</dd></div><div><dt>执行通道</dt><dd>{session?.surface==='work'?'Work':'Code'}</dd></div></dl><button className="v2-settings-row" onClick={()=>{reconnect();setSheet(null);}}><Icon name="retry" size={18}/>重新同步<Icon name="chevron" size={15}/></button></>}
      {sheet.kind==='new'&&<><p className="v2-sheet-explanation">选择要在电脑上开始的工作。</p><button className="v2-new-choice" disabled={!ready||pending} onClick={()=>void create('code')}><Icon name="terminal"/><span><strong>Code</strong><small>编写代码、调试与项目开发</small></span><Icon name="chevron" size={16}/></button><button className="v2-new-choice" disabled={!ready||pending} onClick={()=>void create('work')}><Icon name="file"/><span><strong>Work</strong><small>资料整理、文档和日常工作</small></span><Icon name="chevron" size={16}/></button></>}
      {sheet.kind==='stop'&&<p className="v2-sheet-explanation">将请求电脑停止当前任务。已经收到的内容和执行记录会保留。</p>}
      {sheet.kind==='help'&&<div className="v2-help"><p>在 Trylo Desktop 中打开「手机扫码配对」。</p><p>开启远程连接，确认电脑显示可用的 HTTPS 远程地址。</p><p>用手机扫描二维码，验证电脑身份后同步会话。</p></div>}
    </SheetPanel>}
  </div></div></section>;
}

export default function Preview() {
  const [snapshot,setSnapshot]=useState<RemoteSnapshot|null>(null);
  const [state,setState]=useState<GatewayConnectionState>('connecting');
  const [paused,setPaused]=useState(false);
  const [generation,setGeneration]=useState(0);
  const [receivedAt,setReceivedAt]=useState(0);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const [artifacts,setArtifacts]=useState<RemoteArtifact[]>([]);
  const [dark,setDark]=useState(false);
  const mutation = useRef(false);
  const ready=state==='connected'&&!paused;
  useEffect(()=>{if(paused){setState('offline');return;}return client.subscribe(next=>{setSnapshot(next);setReceivedAt(Date.now());},setState);},[paused,generation]);
  useEffect(()=>{let cancelled=false;if(!ready)return;void client.getArtifacts().then(files=>{if(!cancelled)setArtifacts(files);}).catch(()=>{if(!cancelled)setArtifacts([]);});return()=>{cancelled=true;};},[ready,snapshot?.activeSessionId,snapshot?.agent.status,snapshot?.agent.phase]);
  const perform=async(operation:()=>Promise<unknown>)=>{if(!ready||mutation.current)return false;mutation.current=true;setPending(true);setError('');try{await operation();return true;}catch(cause){setError(cause instanceof Error?cause.message:'操作失败，请重试');return false;}finally{mutation.current=false;setPending(false);}};
  const reconnect=()=>{setState('connecting');setPaused(false);setGeneration(value=>value+1);setError('');};
  return <RemoteContext.Provider value={{snapshot,ready,state,receivedAt,pending,error,artifacts,paused,reconnect,pause:()=>setPaused(v=>!v),perform}}><div className={`v2-showcase${dark?' v2-dark':''}`}><header className="v2-preview-bar"><div><Mark/><strong>Trylo Mobile</strong><span>双模式 · 示例</span></div><div><span className="v2-fixture-label">本机合成数据</span><a href="http://127.0.0.1:4183/preview/index.html">第一版</a><button onClick={()=>setPaused(v=>!v)}>{paused?'恢复连接':'模拟断线'}</button><button aria-label={dark?'切换浅色':'切换深色'} onClick={()=>setDark(v=>!v)}><Icon name={dark?'sun':'moon'} size={17}/></button></div></header><div className="v2-showcase-title"><h1>同一段工作，两种看法。</h1><p>对话模式专注阅读，过程模式跟进执行。审批共用同一套面板。</p></div><main className="v2-stages"><Phone companion/><Phone/></main><footer className="v2-research"><details><summary>设计参考与本版范围</summary><p>参考 <a href="https://code.claude.com/docs/en/remote-control" target="_blank" rel="noreferrer">Claude Remote Control</a> 的连续会话、<a href="https://github.blog/changelog/2025-08-19-agents-panel-launch-copilot-coding-agent-tasks-anywhere-on-github-com/" target="_blank" rel="noreferrer">GitHub Agents panel</a> 的任务状态和 <a href="https://m3.material.io/components/bottom-sheets/guidelines" target="_blank" rel="noreferrer">Google Material</a> 的底部操作面板。</p><p>本版使用真实 Gateway 与合成电脑任务；未替换正式 UI，未新增真实推送或后台多会话能力。</p></details></footer></div></RemoteContext.Provider>;
}
