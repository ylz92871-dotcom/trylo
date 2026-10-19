import { useCallback, useEffect, useRef, useState, type ReactElement, type FormEvent } from 'react';
import { RadioTower, RefreshCw, X, Cloud, Link, Monitor, Smartphone, ShieldCheck, Check } from 'lucide-react';
import { remoteSettingsDefaults, type RemoteSettings } from '../../settings/settings-store';
import type { RemotePairingInfoResult, RemoteStatusResult, RelayAccountStatus } from '../../services-host/methods';
import type { RelayAccountActions } from './SettingsModal';

export interface RemotePairingModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly remoteStatus?: RemoteStatusResult | null;
  readonly remoteController?: ({ pairing(): Promise<RemotePairingInfoResult>; status?(): RemoteStatusResult } & Partial<RelayAccountActions>) | null;
  readonly remoteEnabled?: boolean;
  readonly onRemoteToggle?: () => void;
  readonly remoteSettings?: RemoteSettings;
  readonly onConfigure?: (settings: RemoteSettings) => Promise<void>;
}

export function RemotePairingModal(props: RemotePairingModalProps): ReactElement | null {
  const [draft, setDraft] = useState(props.remoteSettings ?? remoteSettingsDefaults());
  const [account, setAccount] = useState<RelayAccountStatus | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [pairing, setPairing] = useState<RemotePairingInfoResult['pairing']>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; detail: string; action: () => Promise<void> } | null>(null);
  const request = useRef(0), pending = useRef(false), recoveryQrNeeded = useRef(false);
  const liveStatus = useRef(props.remoteStatus);
  liveStatus.current = props.remoteStatus;
  const enabled = props.remoteEnabled ?? false, status = props.remoteStatus;
  const running = status?.running ?? false, reconnecting = status?.reasonCode === 'relay_reconnecting';
  const mode = draft.connectionMode ?? status?.connectionMode ?? 'server';
  const wasRunning = useRef(running);

  useEffect(() => { if (props.open) setDraft(props.remoteSettings ?? remoteSettingsDefaults()); }, [props.open, props.remoteSettings]);
  useEffect(() => {
    if (!props.open) { setPassword(''); setInvite(''); setConfirm(null); return; }
    let active = true;
    void props.remoteController?.relayStatus?.().then(value => { if (active) { setAccount(value); setUsername(value.username); } }).catch(() => { if (active) setError('暂时无法读取账号，请重试。'); });
    return () => { active = false; };
  }, [props.open, props.remoteController]);

  const generate = useCallback((): void => {
    if (!props.open || !enabled || !props.remoteController) return;
    const id = ++request.current;
    pending.current = true; setQr(null); setError(null); setLoading(true);
    void props.remoteController.pairing().then(info => {
      if (!info.qrDataUrl) throw new Error('配对二维码生成失败，请重试。');
      // React can still have the previous stopped props after a successful
      // startup promise. Read the controller's current authority instead.
      const current = props.remoteController?.status?.() ?? liveStatus.current;
      if (current?.running === false) throw new Error(current.reasonCode === 'relay_reconnecting' ? '服务器连接暂时中断，正在自动重连。请稍后重试生成二维码。' : '远程服务已断开，请重试启动。');
      if (id === request.current) { setQr(info.qrDataUrl); setPairing(info.pairing); }
    }).catch((failure: unknown) => { if (id === request.current) setError(failure instanceof Error ? failure.message : String(failure)); })
      .finally(() => { if (id === request.current) { pending.current = false; setLoading(false); } });
  }, [props.open, enabled, props.remoteController]);
  useEffect(() => {
    setQr(null); setError(null); setLoading(false); pending.current = false; generate();
    return () => { ++request.current; pending.current = false; };
  }, [generate]);
  useEffect(() => {
    if (!running) { setQr(null); recoveryQrNeeded.current = true; }
    if (wasRunning.current && !running && !pending.current) {
      ++request.current; setLoading(false);
      if (props.open && enabled) setError(reconnecting ? '服务器连接暂时中断，正在自动重连。' : '远程服务已断开，请重试启动。');
    }
    if (!wasRunning.current && running && props.open && enabled && !pending.current) { recoveryQrNeeded.current = false; generate(); }
    wasRunning.current = running;
  }, [running, reconnecting, props.open, enabled, generate]);
  useEffect(() => {
    if (!running || loading || !props.open || !enabled || !recoveryQrNeeded.current) return;
    recoveryQrNeeded.current = false;
    if (!qr && !pending.current) generate();
  }, [running, loading, qr, props.open, enabled, generate]);
  useEffect(() => {
    if (!pairing?.expiresAt || !qr || !props.open || !enabled || !running) return;
    const timer = setTimeout(generate, Math.max(1000, pairing.expiresAt - Date.now() - 5000));
    return () => clearTimeout(timer);
  }, [pairing, qr, props.open, enabled, running, generate]);

  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : '连接失败，请重试。'); }
    finally { setBusy(false); }
  }
  async function configure(next: RemoteSettings) {
    if (!props.onConfigure) throw new Error('请在 Desktop 中配置远程连接。');
    await props.onConfigure(next); setDraft(next);
  }
  function switchMode(next: 'server' | 'tunnel') {
    if (next === mode) return;
    const action = async () => { ++request.current; setQr(null); await configure({ ...draft, connectionMode: next, enabled: false }); };
    if (enabled) setConfirm({ title: '切换连接方式？', detail: '当前手机连接会断开。新连接就绪后，请重新扫码。', action });
    else void perform(action);
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    if (!props.remoteController?.relayLogin) return;
    await perform(async () => {
      const next = await props.remoteController!.relayLogin!({ serverUrl: draft.relayUrl || 'https://relay.trylocode.me', username, password, register, inviteCode: invite });
      setPassword(''); setInvite(''); setAccount(next);
      await configure({ ...draft, connectionMode: 'server', enabled: true, relayUrl: next.serverUrl });
    });
  }
  if (!props.open) return null;
  const needsLogin = mode === 'server' && account?.loggedIn === false;
  const headline = needsLogin ? '登录后即可连接这台电脑' : !enabled ? '远程访问已暂停' : running ? mode === 'server' ? '已连接到官方服务器' : '独立隧道已连接' : reconnecting ? '服务器连接中断，正在重连' : loading ? '正在连接这台电脑' : '远程连接尚未就绪';
  const retryLabel = running ? '刷新二维码' : reconnecting ? '重连并生成二维码' : '重试启动并生成二维码';
  return <div className="remote-pairing-modal__overlay" role="presentation" onClick={e => { if (e.target === e.currentTarget) props.onClose(); }}>
    <section className="remote-pairing-modal" role="dialog" aria-modal="true" aria-labelledby="remote-pairing-modal__title" onKeyDown={e => {
      if (e.key === 'Escape') { if (confirm) setConfirm(null); else props.onClose(); }
      if (e.key !== 'Tab') return;
      const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary,select')).filter(n => n.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}>
      <header className="remote-pairing-modal__header"><div className="remote-connect__title"><span><RadioTower size={23}/></span><div><h2 id="remote-pairing-modal__title">远程与连接</h2><p>用手机继续这台电脑上的工作</p></div></div><button type="button" className="remote-pairing-modal__close" onClick={props.onClose} aria-label="关闭远程与连接" autoFocus><X size={18}/></button></header>
      <div className="remote-connect__content"><div className="remote-connect__tabs" role="tablist" aria-label="连接方式">
        <button type="button" id="remote-tab-server" role="tab" aria-selected={mode === 'server'} aria-controls="remote-panel" disabled={busy} onClick={() => switchMode('server')}><Cloud size={18}/>官方服务器<small>推荐</small></button>
        <button type="button" id="remote-tab-tunnel" role="tab" aria-selected={mode === 'tunnel'} aria-controls="remote-panel" disabled={busy} onClick={() => switchMode('tunnel')}><Link size={18}/>独立隧道</button>
      </div><div id="remote-panel" role="tabpanel" aria-labelledby={`remote-tab-${mode}`}>
        <div className={`remote-connect__status ${running && enabled ? 'is-online' : ''}`} role="status" aria-live="polite"><i/><div><strong>{headline}</strong><p>{running && enabled ? '这台电脑已就绪，可以从手机继续工作' : reconnecting ? '连接恢复后，二维码会自动更新' : '连接方式和账号会保存在这台电脑上'}</p></div>{!needsLogin && <button type="button" disabled={busy} onClick={() => {
          if (!enabled) void perform(async () => { if (props.onConfigure) await configure({ ...draft, connectionMode: mode, enabled: true }); else props.onRemoteToggle?.(); });
          else if (!running) generate();
          else setConfirm({ title: '暂停远程访问？', detail: '手机将暂时无法操作这台电脑，之后可在这里恢复。', action: async () => { if (props.onConfigure) await configure({ ...draft, enabled: false }); else props.onRemoteToggle?.(); } });
        }}>{!enabled ? '恢复连接' : running ? '暂停连接' : '立即重试'}</button>}</div>
        {needsLogin ? <div className="remote-connect__grid remote-connect__login"><form onSubmit={login}><h3>{register ? '创建 Trylo 账号' : '登录 Trylo 账号'}</h3><p>登录、扫码，将手机与你的 Desktop 配对。</p>
          <label>账号<input autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)}/></label><label>密码<input type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 12 : undefined} value={password} onChange={e => setPassword(e.target.value)}/></label>
          {register && <label>注册邀请码<input type="password" autoComplete="off" required value={invite} onChange={e => setInvite(e.target.value)}/></label>}
          <button type="submit" className="remote-pairing-modal__btn remote-pairing-modal__btn--primary" disabled={busy}>{busy ? '正在连接…' : register ? '注册并连接' : '登录并连接'}</button><button type="button" className="remote-connect__text" disabled={busy} onClick={() => { setRegister(!register); setError(null); }}>{register ? '已有账号？直接登录' : '还没有账号？注册账号'}</button>
        </form><div className="remote-connect__benefits"><div className="remote-connect__route"><Smartphone/><Cloud/><Monitor/></div><h3><Check size={16}/>不用自己配置隧道</h3><p>连接官方服务器，就可以配对你的电脑。</p><h3><Check size={16}/>工作留在自己的 Desktop</h3><p>手机同步会话和审批，任务由这台电脑执行。</p></div></div>
        : <div className="remote-connect__grid"><div className="remote-connect__pairing"><h3>连接手机<small>扫码配对</small></h3><div className="remote-connect__qr">{qr && enabled ? <img src={qr} alt="配对二维码 — 用手机扫码连接"/> : <div>{loading ? <RefreshCw className="remote-pairing-modal__spin"/> : <Smartphone/>}<span>{loading ? '正在生成二维码' : !enabled ? '恢复连接后显示二维码' : reconnecting ? '正在恢复服务器连接' : '连接就绪后显示二维码'}</span></div>}</div><p>打开 Trylo 手机 App，扫一扫<small>只配对这台电脑，同步会话和审批</small></p><button type="button" className="remote-connect__text" onClick={generate} disabled={loading || !enabled || busy}><RefreshCw size={15} className={loading ? 'remote-pairing-modal__spin' : undefined}/>{loading ? '正在生成…' : retryLabel}</button></div>
        <div className="remote-connect__details">{mode === 'tunnel' && <><h3>隧道连接</h3><div className="remote-connect__tunnels" role="group" aria-label="隧道类型">{(['quick', 'named', 'manual'] as const).map(type => <button type="button" key={type} aria-pressed={draft.tunnelMode === type} onClick={() => setDraft({ ...draft, tunnelMode: type })}>{type === 'quick' ? '自动创建' : type === 'named' ? '固定隧道' : '已有地址'}</button>)}</div><p>{draft.tunnelMode === 'quick' ? '由 Desktop 自动创建临时隧道，重启后可能需要重新扫码。' : '使用已经配置好的固定隧道或 HTTPS 公网地址。'}</p>{draft.tunnelMode !== 'quick' && <label>公网地址<input type="url" value={draft.publicUrl} onChange={e => setDraft({ ...draft, publicUrl: e.target.value })}/></label>}<button type="button" className="remote-connect__text" disabled={busy} onClick={() => void perform(() => configure({ ...draft, connectionMode: 'tunnel', enabled: true }))}>应用隧道并连接</button><hr/></>}
          <h3>当前电脑</h3><div className="remote-connect__device"><Monitor size={24}/><div><strong>{pairing?.deviceName || '我的 Desktop'}</strong><p>{pairing?.workspaceName || '当前工作空间'}</p></div><small>{running && enabled ? '已就绪' : '待连接'}</small></div><hr/><h3>手机配对</h3><p>手机扫码后，即可查看会话、发送任务和处理审批。</p>
          {mode === 'server' && <><hr/><div className="remote-connect__account"><span>{account?.username || '读取账号中…'}</span>{account?.loggedIn && <button type="button" disabled={busy} onClick={() => setConfirm({ title: '退出 Trylo 账号？', detail: '退出会撤销当前手机配对。再次登录后，需要重新扫码。', action: async () => { setAccount(await props.remoteController!.relayLogout!()); await configure({ ...draft, enabled: false }); } })}>退出账号</button>}</div><p className="remote-connect__server"><Cloud size={14}/>{account?.serverUrl || draft.relayUrl}</p></>}
        </div></div>}
        {(error || status?.error) && <p className="remote-connect__error" role="alert">{error || status?.error}</p>}
        <div className="remote-connect__hint"><Monitor size={16}/><span>电脑保持开机并运行 Trylo Desktop。{mode === 'server' ? '连接数据经服务器转发。' : '切换连接方式后，请让手机重新扫码。'}</span></div>
        <details className="remote-connect__advanced"><summary>高级选项</summary><div>{mode === 'server' && <label>服务器地址<input type="url" value={draft.relayUrl || ''} onChange={e => setDraft({ ...draft, relayUrl: e.target.value })}/></label>}<label>本机端口<input type="number" min={1024} max={65535} value={draft.port} onChange={e => setDraft({ ...draft, port: Number(e.target.value) })}/></label>{mode === 'tunnel' && <label>cloudflared 路径<input value={draft.cloudflaredPath} placeholder="留空使用内置客户端" onChange={e => setDraft({ ...draft, cloudflaredPath: e.target.value })}/></label>}</div><button type="button" className="remote-connect__text" disabled={busy} onClick={() => void perform(() => configure({ ...draft, connectionMode: mode, enabled }))}>应用更改</button></details>
      </div></div>
      <footer className="remote-pairing-modal__footer"><span><ShieldCheck size={15}/>操作与审批始终由这台电脑处理</span><button type="button" className="remote-pairing-modal__btn remote-pairing-modal__btn--ghost" onClick={props.onClose}>完成</button></footer>
      {confirm && <div className="remote-connect__confirm"><div role="alertdialog" aria-modal="true" aria-labelledby="remote-confirm-title"><h3 id="remote-confirm-title">{confirm.title}</h3><p>{confirm.detail}</p><div><button type="button" autoFocus onClick={() => setConfirm(null)}>取消</button><button type="button" className="remote-pairing-modal__btn remote-pairing-modal__btn--primary" onClick={() => { const action = confirm.action; setConfirm(null); void perform(action); }}>确认</button></div></div></div>}
    </section></div>;
}
