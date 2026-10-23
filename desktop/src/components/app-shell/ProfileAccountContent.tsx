import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Check, Clock3, ExternalLink, LogOut, Pencil, X } from 'lucide-react';
import type { DesktopAccountModel } from '../../account/desktop-account';

export function ProfileAccountContent(props: {
  readonly account: DesktopAccountModel;
  readonly avatar: ReactNode;
  readonly nickname: string;
  readonly remoteActive?: boolean;
  readonly onEditProfile: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const { account } = props;
  const [copyNotice, setCopyNotice] = useState('');
  const [confirmLogout, setConfirmLogout] = useState(false);
  useEffect(() => { setConfirmLogout(false); }, [account.account?.loggedIn, account.account?.username]);
  const run = (action: () => Promise<void>): void => { void action(); };
  const failure = account.error && <p className="profile-account__error" role="alert">{account.error}</p>;

  if (account.login) return <div className="profile-account">
    <div className="profile-account__step-head"><h2>在浏览器中继续</h2><button type="button" className="profile-account__icon" aria-label="收起账号弹窗" onClick={props.onClose}><X size={15}/></button></div>
    <p className="profile-account__description">登录或使用邀请码注册后，<br/>确认这是你的 Desktop 登录请求。</p>
    <div className="profile-account__code-area"><span>请核对网页上的验证码</span><code>{account.login.userCode.match(/.{1,4}/g)?.join(' ')}</code></div>
    <p className="profile-account__waiting" role="status"><Clock3 size={14}/>等待浏览器确认…</p>
    {failure}
    <div className="profile-account__actions"><button type="button" className="profile-account__primary" onClick={() => run(account.reopen)}>重新打开浏览器<ExternalLink size={13}/></button><button type="button" className="profile-account__text" onClick={() => run(account.cancel)}>取消</button></div>
    {account.error && <button type="button" className="profile-account__text" onClick={() => {
      if (!navigator.clipboard?.writeText) { setCopyNotice('当前环境无法复制，请重新打开浏览器'); return; }
      void navigator.clipboard.writeText(account.login!.verificationUrl).then(() => setCopyNotice('登录链接已复制')).catch(() => setCopyNotice('无法复制，请重新打开浏览器'));
    }}>复制登录链接</button>}
    <p className="profile-account__footnote" role={copyNotice ? 'status' : undefined}>{copyNotice || `验证码有效至 ${new Date(account.login.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</p>
  </div>;

  if (account.phase === 'expired' || account.phase === 'error') return <div className="profile-account">
    <div className="profile-account__step-head"><h2>{account.phase === 'expired' ? '登录请求已过期' : account.account === null ? '暂时无法读取账号' : '暂时无法完成登录'}</h2></div>
    {account.phase === 'expired' ? <p className="profile-account__description" role="status">验证码已失效，请重新发起登录。</p> : failure}
    <div className="profile-account__actions"><button type="button" className="profile-account__primary" onClick={() => run(account.phase === 'expired' ? account.start : account.retry)}>{account.phase === 'expired' ? '重新登录' : '重试'}</button><button type="button" className="profile-account__text" onClick={props.onClose}>关闭</button></div>
  </div>;

  return <div className="profile-account">
    <div className="profile-account__head">{props.avatar}<div><strong>{props.nickname}</strong><small>{account.account?.loggedIn ? <><Check size={12}/>{account.account.username}</> : account.phase === 'checking' ? '正在读取账号…' : '未登录 Trylo 账号'}</small></div></div>
    {confirmLogout && account.account?.loggedIn ? <>
      <h2>退出 Trylo 账号？</h2><p className="profile-account__description">本机任务和文件会保留，通过官方服务器连接的手机将断开。</p>
      <div className="profile-account__actions"><button type="button" className="profile-account__primary" disabled={account.busy} onClick={() => { setConfirmLogout(false); run(account.logout); }}>退出账号</button><button type="button" className="profile-account__text" onClick={() => setConfirmLogout(false)}>取消退出</button></div>
    </> : <>
      {account.account?.loggedIn ? <button type="button" className="profile-account__menu" disabled={account.busy} onClick={() => run(account.openCenter)}><ExternalLink size={15}/>账号中心</button> : <>
        <button type="button" className="profile-account__primary" disabled={account.busy} onClick={() => run(account.start)}>{account.phase === 'starting' ? '正在打开浏览器…' : account.phase === 'checking' ? '正在读取账号…' : account.phase === 'cancelling' ? '正在取消…' : '在浏览器中登录'}<ExternalLink size={13}/></button>
        <p className="profile-account__caption">与网页使用同一个 Trylo 账号</p>
        {account.phase === 'starting' && <button type="button" className="profile-account__text" onClick={() => run(account.cancel)}>取消登录</button>}
      </>}
      {failure}
      {account.error && <button type="button" className="profile-account__text" disabled={account.busy} onClick={() => run(account.retry)}>重试</button>}
      <div className="profile-account__divider"/>
      <button type="button" className="profile-account__menu" onClick={props.onEditProfile}><Pencil size={15}/>编辑个人资料</button>
      {account.account?.loggedIn && <button type="button" className="profile-account__menu" disabled={account.busy} onClick={() => props.remoteActive ? setConfirmLogout(true) : run(account.logout)}><LogOut size={15}/>{account.phase === 'loggingout' ? '正在退出…' : '退出账号'}</button>}
    </>}
  </div>;
}
