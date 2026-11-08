import React, { useEffect, useRef, useState } from 'react';
import { RemoteGatewayClient, type RemoteSnapshot, type GatewayConnectionState, type RemoteChatMessage } from '../src/gateway';
import './preview.css';

// Development preview has its own client and never reads/writes saved pairing.
const client = new RemoteGatewayClient({ baseUrl: 'http://127.0.0.1:49414', token: 'trylo-mobile-preview-synthetic-only-20261015', demo: false });
const Icon = ({ name, size = 20 }: { name: string; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{({
  menu: <><path d="M4 6h16M4 12h12M4 18h16"/></>,
  add: <><path d="M12 5v14M5 12h14"/></>,
  desktop: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>,
  arrow: <><path d="m6 12 6-6 6 6M12 6v13"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  file: <><path d="M13 3H6v18h12V8zM13 3v5h5M9 13h6M9 17h4"/></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  link: <><path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/></>,
})[name]}</svg>;
const Mark = () => <svg className="brand-mark" viewBox="0 0 1024 1024" fill="none" aria-hidden="true"><g stroke="currentColor" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round"><path d="M462 236 L462 420 L624 420"/><path d="M276 732 L424 644 L356 512"/><path d="M540 676 L622 546 L786 640"/></g></svg>;

function Process({ message }: { message: RemoteChatMessage }) {
  const thinking = message.role === 'thinking';
  const label = message.status === 'streaming' ? '进行中' : message.status === 'error' ? '失败' : message.status === 'interrupted' ? '已中断' : '完成';
  return <details className={`event ${thinking ? 'thinking' : ''}`}><summary><span className="event-symbol">{thinking ? <span className="thought-symbol">✧</span> : <Icon name={/检查/.test(message.title || '') ? 'terminal' : 'file'} size={17}/>}</span><span className="event-title">{message.title || '思考摘要'}{!thinking && message.input && <small>{(() => { try { const p = JSON.parse(message.input!); return p.path || p.command; } catch { return ''; } })()}</small>}</span><span className="event-status">{message.status !== 'streaming' && !thinking && <Icon name={label === '完成' ? 'check' : 'close'} size={13}/>} {thinking ? '思考摘要' : label}</span><Icon name="chevron" size={13}/></summary><div className="event-body">{thinking ? <p>{message.text}</p> : <>{message.input && <><label>输入</label><pre>{message.input}</pre></>}{message.output && <><label>结果</label><pre>{message.output}</pre></>}{message.durationMs != null && <small>耗时 {(message.durationMs / 1000).toFixed(2)} 秒</small>}</>}</div></details>;
}
export default function Preview() {
  const [snapshot, setSnapshot] = useState<RemoteSnapshot | null>(null);
  const [state, setState] = useState<GatewayConnectionState>('connecting');
  const [version, setVersion] = useState(0);
  const [paused, setPaused] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [device, setDevice] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState('');
  const [dark, setDark] = useState(false);
  const [receivedAt, setReceivedAt] = useState(0);
  const [following, setFollowing] = useState(true);
  const feed = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (paused) { setState('offline'); return; }
    return client.subscribe(next => { setSnapshot(next); setReceivedAt(Date.now()); }, setState);
  }, [version, paused]);
  useEffect(() => { if (following && feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [snapshot?.conversation, following]);
  const ready = state === 'connected' && !paused;
  const active = snapshot?.sessions.find(s => s.id === snapshot.activeSessionId);
  const status = !ready ? state === 'offline' ? '离线' : '正在同步' : '已同步';
  const approvals = snapshot?.approvals || [];
  const running = snapshot && !['idle', 'done', 'failed'].includes(snapshot.agent.status) && snapshot.agent.phase !== 'stopped';
  const perform = async (name: string, operation: () => Promise<unknown>) => {
    if (!ready || pending) return;
    setPending(name); setNotice('');
    try { await operation(); } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败，请重试'); }
    finally { setPending(''); }
  };
  const send = (value: string) => perform('send', async () => { await client.sendChat(value, undefined, { surface: active?.surface || 'code' }); setText(''); setFollowing(true); });
  const pause = () => { setPaused(value => !value); setDevice(false); };
  return <div className={`preview-page${dark ? ' dark' : ''}`}>
    <aside className="design-note"><a className="wordmark" href="/preview/index.html"><Mark/>Trylo</a><span className="preview-badge">手机端交互预览 · 0.1</span><h1>电脑上的工作，<br/>在手机上接着看。</h1><p className="intro">同一个项目、同一段对话、同一条执行过程。把连接是否可靠，放在看得见的地方。</p><div className="design-points"><section><Icon name="link"/><div><h2>先同步，再操作</h2><p>返回前台先恢复电脑当前状态。离线保留内容，恢复同步后开放操作。</p></div></section><section><Icon name="file"/><div><h2>过程跟着对话走</h2><p>思考摘要和工具按发生顺序展开。点开任一操作，查看输入与结果。</p></div></section><section><Icon name="shield"/><div><h2>需要你时，明确停下</h2><p>审批原因就近展示。允许、拒绝和停止，都等待电脑端确认。</p></div></section></div><div className="preview-controls"><strong>试一试这版交互</strong><div><button onClick={() => void send('重新检查手机端远程连接。')} disabled={!ready || !!pending}>重播任务</button><button onClick={pause}>{paused ? '恢复连接' : '模拟断线'}</button><button onClick={() => setDark(!dark)}>{dark ? '浅色外观' : '深色外观'}</button></div><small>真实 Gateway 与手机连接代码；任务、电脑和审批均为本机合成数据。<br/>这是一版待确认的独立预览，尚未替换正式 APP 界面。</small></div></aside>
    <div className="device-stage"><div className="phone"><div className="phone-app">
      <header><div className="topbar"><button className="icon-button" aria-label="打开会话列表" onClick={() => setDrawer(true)}><Icon name="menu"/></button><span className="app-brand"><Mark/>Trylo</span><button className="icon-button" aria-label="新建会话" disabled={!ready || !!pending} onClick={() => void perform('new', () => client.createSession(active?.surface || 'code'))}><Icon name="add"/></button></div><button className={`connection-bar ${ready ? 'online' : 'offline'}`} onClick={() => setDevice(!device)}><Icon name="desktop" size={15}/><span>{snapshot?.device.name || '正在连接电脑'}</span><span className="connection-state"><i/>{status}</span><Icon name="chevron" size={12}/></button><div className="session-heading"><div><span>Trylo / {active?.surface === 'work' ? 'Work' : 'Code'}</span><h2>{active?.title || '远程会话'}</h2></div><span className="surface-badge">{active?.surface === 'work' ? 'Work' : 'Code'}</span></div></header>
      {device && <section className="device-popover"><strong>{ready ? '已与电脑同步' : '连接正在恢复'}</strong><p>{ready ? '当前会话、执行状态和待审批操作已从电脑更新。' : '已保留收到的内容。同步完成前暂停发送和审批。'}</p><dl><dt>当前项目</dt><dd>{snapshot?.device.workspace || '—'}</dd><dt>最近接收</dt><dd>{receivedAt ? new Date(receivedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '等待同步'}</dd></dl><button onClick={pause}>{paused ? '恢复连接' : '模拟断线'}</button></section>}
      {!ready && <div className="offline-banner" role="status">{paused ? '连接已暂停，当前内容为断线前记录。' : '正在连接并同步电脑，请稍候。'}<button onClick={() => { setPaused(false); setVersion(v => v + 1); }}>重新连接</button></div>}
      <div className="feed" ref={feed} onScroll={() => { const e = feed.current; if (e) setFollowing(e.scrollHeight - e.scrollTop - e.clientHeight < 60); }}>
        <div className="history-divider"><span>当前电脑会话</span></div>
        {!snapshot?.conversation.length && <div className="empty"><Mark/><h3>接着电脑上的工作</h3><p>发送一条消息，在电脑上开始执行。<br/>过程和结果会同步到这里。</p><button disabled={!ready} onClick={() => void send('检查手机端远程连接，并整理事件展示。')}>检查远程连接</button></div>}
        {snapshot?.conversation.map(message => message.role === 'thinking' || message.role === 'tool' ? <Process key={message.id} message={message}/> : message.role === 'user' ? <div className="user-message" key={message.id}>{message.text}</div> : <article className="assistant-message" key={message.id}><div className="assistant-label"><Mark/>Trylo</div><div>{message.text.split('\n').map((line, index) => <p key={index}>{line}</p>)}</div>{message.status === 'streaming' && <span className="stream-caret"/>}</article>)}
        {snapshot?.agent.phase === 'stopped' && <div className="result-state"><Icon name="stop" size={14}/>电脑已停止本次任务</div>}
        {snapshot?.agent.status === 'done' && <div className="result-state success"><Icon name="check" size={15}/>本次任务已完成</div>}
        {snapshot?.agent.status === 'failed' && <div className="error" role="alert">{snapshot.agent.detail}</div>}
      </div>
      {!following && <button className="jump" onClick={() => setFollowing(true)}>查看最新进展 ↓</button>}
      <div className="bottom-area">
        {!!approvals.length && <section className="approval"><div className="approval-title"><Icon name="shield" size={17}/><strong>需要你确认</strong><span>仅本次</span></div><p>在电脑上{approvals[0].title}</p><code>{approvals[0].detail}</code><details><summary>操作说明</summary><p>{approvals[0].description}</p></details><div className="approval-actions"><button disabled={!ready || !!pending} onClick={() => void perform('deny', () => client.decidePermission(approvals[0].id, 'deny'))}>{pending === 'deny' ? '正在提交…' : '拒绝'}</button><button className="primary" disabled={!ready || !!pending} onClick={() => void perform('allow', () => client.decidePermission(approvals[0].id, 'allow'))}>{pending === 'allow' ? '正在提交…' : '允许本次'}</button></div></section>}
        {notice && <div className="error" role="alert">{notice}</div>}
        <div className="run-status" role="status"><span><i className={running && ready ? 'pulse' : ''}/>{!ready ? '等待重新同步' : approvals.length ? '电脑正在等待审批' : snapshot?.agent.phase === 'stopped' ? '已停止，可开始新任务' : snapshot?.agent.status === 'done' ? '电脑已完成任务' : running ? '电脑正在执行' : '电脑已就绪'}</span>{running && <button disabled={!ready || !!pending} onClick={() => void perform('stop', () => client.cancelCurrentTask())}><Icon name="stop" size={12}/>{pending === 'stop' ? '已请求…' : '停止'}</button>}</div>
        <form className="composer" onSubmit={event => { event.preventDefault(); if (text.trim()) void send(text.trim()); }}><textarea aria-label="发送到电脑的消息" rows={2} placeholder={ready ? '让电脑继续做点什么…' : '同步完成后即可继续…'} value={text} onChange={e => setText(e.target.value)}/><div><span>发送到电脑 <b>{active?.surface === 'work' ? 'Work' : 'Code'}</b></span><button className="send" aria-label="发送" disabled={!ready || !!pending || !text.trim()}><Icon name="arrow" size={18}/></button></div></form>
        <footer><Icon name="desktop" size={11}/>远程工作台<span>预览数据</span><button className="mobile-reconnect" onClick={pause}>{paused ? '恢复连接' : '模拟断线'}</button></footer>
      </div>
      {drawer && <div className="drawer-overlay"><button aria-label="关闭会话列表" className="scrim" onClick={() => setDrawer(false)}/><aside className="drawer"><div><span className="app-brand"><Mark/>Trylo</span><button className="icon-button" aria-label="关闭" onClick={() => setDrawer(false)}><Icon name="close"/></button></div><h3>当前项目</h3><p className="project-row"><Icon name="file" size={17}/>Trylo</p><h3>电脑上的会话</h3>{snapshot?.sessions.map(session => <button className={`session-row ${session.id === snapshot.activeSessionId ? 'selected' : ''}`} key={session.id} disabled={!ready || !!pending} onClick={() => void perform('select', async () => { await client.selectSession(session.id); setDrawer(false); setFollowing(true); })}><span>{session.title}</span><small>{session.surface === 'work' ? 'Work' : 'Code'}</small></button>)}<button className="new-work" disabled={!ready || !!pending} onClick={() => void perform('work', async () => { await client.createSession('work'); setDrawer(false); })}><Icon name="add" size={16}/>新建 Work 会话</button><div className="drawer-end"><Icon name="desktop" size={16}/>本机验收电脑<span>{status}</span></div></aside></div>}
    </div></div><p className="stage-caption">393 × 852 · 点击工具展开详情，允许或拒绝审批</p></div>
  </div>;
}
