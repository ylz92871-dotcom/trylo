import { useCallback, useEffect, useRef, useState } from 'react';
import type { RelayAccountStatus, RelayBrowserLogin } from '../services-host/methods';
import type { AccountPhase, DesktopAccountModel, DesktopAccountPort } from './desktop-account';

type FailureAction = 'refresh' | 'start' | 'logout' | 'center' | 'reopen';
interface AccountOptions {
  readonly serverUrl: string;
  readonly onSessionChanged?: (account: RelayAccountStatus) => Promise<void>;
}
const failureText = (error: unknown, fallback: string): string => error instanceof Error ? error.message : fallback;

/** Shell-owned: closing the avatar card never cancels an outstanding browser handoff. */
export function useDesktopAccount(port: DesktopAccountPort | null | undefined, options: AccountOptions): DesktopAccountModel {
  const [phase, setPhase] = useState<AccountPhase>('checking');
  const [account, setAccount] = useState<RelayAccountStatus | null>(null);
  const [login, setLogin] = useState<RelayBrowserLogin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef(0), readRequest = useRef(0), operating = useRef(false);
  const accountRef = useRef(account), loginRef = useRef(login), context = useRef(options);
  const failureAction = useRef<FailureAction>('refresh');
  context.current = options;
  accountRef.current = account;
  loginRef.current = login;

  const refresh = useCallback(async (): Promise<void> => {
    if (operating.current || loginRef.current) return;
    const owner = scope.current, request = ++readRequest.current;
    if (accountRef.current === null) setPhase('checking');
    try {
      if (!port) throw new Error('账号服务尚未就绪，请稍后重试。');
      const value = await port.relayStatus();
      if (owner !== scope.current || request !== readRequest.current) return;
      accountRef.current = value; setAccount(value); setPhase('ready'); setError(null);
    } catch (failure) {
      if (owner !== scope.current || request !== readRequest.current) return;
      failureAction.current = 'refresh';
      setError(failureText(failure, '暂时无法读取账号，请重试。'));
      setPhase(accountRef.current ? 'ready' : 'error');
    }
  }, [port]);

  const cancel = useCallback(async (): Promise<void> => {
    const owner = ++scope.current;
    operating.current = true; loginRef.current = null; setLogin(null); setPhase('cancelling'); setError(null);
    try { await port?.relayBrowserCancel?.(); }
    catch (failure) {
      if (owner === scope.current) { failureAction.current = 'refresh'; setError(failureText(failure, '取消登录失败，请重试。')); }
    } finally {
      if (owner === scope.current) { operating.current = false; setPhase('ready'); }
    }
  }, [port]);

  const start = useCallback(async (): Promise<void> => {
    if (operating.current || loginRef.current) return;
    const owner = ++scope.current;
    operating.current = true; setError(null); setPhase('starting');
    try {
      if (!port?.relayBrowserBegin || !port.relayBrowserPoll) throw new Error('账号登录服务尚未就绪，请重启 Desktop 后重试。');
      await port.relayBrowserCancel?.();
      if (owner !== scope.current) return;
      const value = await port.relayBrowserBegin({ serverUrl: context.current.serverUrl });
      if (owner !== scope.current) return;
      if (!value.id || !/^[A-F0-9]{12}$/.test(value.userCode) || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error('登录请求已失效，请重新登录。');
      loginRef.current = value; setLogin(value); setPhase('waiting');
      if (value.browserOpened === false) { failureAction.current = 'reopen'; setError('浏览器未能打开，请重新打开或复制登录链接。'); }
    } catch (failure) {
      if (owner !== scope.current) return;
      await port?.relayBrowserCancel?.().catch(() => {});
      if (owner !== scope.current) return;
      failureAction.current = 'start'; setError(failureText(failure, '暂时无法开始登录，请检查网络后重试。')); setPhase('error');
    } finally { if (owner === scope.current) operating.current = false; }
  }, [port]);

  useEffect(() => {
    if (!login || !port?.relayBrowserPoll) return;
    const owner = scope.current;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const current = (): boolean => active && owner === scope.current;
    const expire = (): void => {
      if (!current()) return;
      ++scope.current; loginRef.current = null; setLogin(null); setPhase('expired'); setError(null);
      void port.relayBrowserCancel?.().catch(() => {});
    };
    const schedule = (interval: number): void => {
      const delay = Number.isFinite(interval) ? Math.max(5000, interval) : 5000;
      timer = setTimeout(() => { void poll(); }, Math.min(delay, Math.max(0, login.expiresAt - Date.now())));
    };
    const poll = async (): Promise<void> => {
      if (!current()) return;
      if (Date.now() >= login.expiresAt) { expire(); return; }
      try {
        const result = await port.relayBrowserPoll!({ id: login.id });
        if (!current()) return;
        if (result.status === 'pending') { schedule(result.interval ?? login.interval); return; }
        if (!result.account?.loggedIn) throw new Error('服务器未能确认账号，请重新登录。');
        loginRef.current = null; setLogin(null);
        accountRef.current = result.account; setAccount(result.account); setPhase('ready'); setError(null);
        try { await context.current.onSessionChanged?.(result.account); }
        catch { if (owner === scope.current) { failureAction.current = 'refresh'; setError('已登录，但远程连接状态未能更新，请检查远程连接。'); } }
      } catch (failure) {
        if (!current()) return;
        if (Date.now() >= login.expiresAt || /过期|expired/i.test(failureText(failure, ''))) { expire(); return; }
        loginRef.current = null; setLogin(null); setPhase('error'); failureAction.current = 'start';
        setError(failureText(failure, '登录确认失败，请检查网络后重试。'));
        void port.relayBrowserCancel?.().catch(() => {});
      }
    };
    schedule(login.interval);
    return () => { active = false; clearTimeout(timer); };
  }, [login, port]);

  const logout = useCallback(async (): Promise<void> => {
    if (operating.current || loginRef.current) return;
    const owner = ++scope.current;
    operating.current = true; setPhase('loggingout'); setError(null);
    try {
      if (!port) throw new Error('账号服务尚未就绪，请重试。');
      const value = await port.relayLogout();
      if (owner !== scope.current) return;
      accountRef.current = value; setAccount(value); setPhase('ready');
      await context.current.onSessionChanged?.(value);
    } catch (failure) {
      if (owner !== scope.current) return;
      failureAction.current = accountRef.current?.loggedIn ? 'logout' : 'refresh';
      setError(failureText(failure, '退出账号失败，请重试。')); setPhase('ready');
    } finally { if (owner === scope.current) operating.current = false; }
  }, [port]);

  const reopen = useCallback(async (): Promise<void> => {
    const value = loginRef.current, owner = scope.current;
    if (!value || operating.current) return;
    try {
      if (!port?.relayBrowserOpen) throw new Error('请更新 Desktop 配套服务后重试，或复制登录链接。');
      await port.relayBrowserOpen({ id: value.id });
      if (owner === scope.current) setError(null);
    } catch (failure) { if (owner === scope.current) { failureAction.current = 'reopen'; setError(failureText(failure, '无法打开浏览器，请复制登录链接。')); } }
  }, [port]);
  const openCenter = useCallback(async (): Promise<void> => {
    const owner = scope.current;
    try {
      if (!port?.relayAccountOpen) throw new Error('请更新 Desktop 配套服务后重试。');
      await port.relayAccountOpen();
      if (owner === scope.current) setError(null);
    } catch (failure) { if (owner === scope.current) { failureAction.current = 'center'; setError(failureText(failure, '无法打开账号中心，请重试。')); } }
  }, [port]);
  const retry = useCallback(async (): Promise<void> => {
    await ({ refresh, start, logout, center: openCenter, reopen }[failureAction.current])();
  }, [refresh, start, logout, openCenter, reopen]);
  const invalidateRequests = useCallback((): void => { ++scope.current; ++readRequest.current; }, []);

  useEffect(() => {
    operating.current = false;
    loginRef.current = null; accountRef.current = null;
    setLogin(null); setAccount(null); setError(null);
    void refresh();
    const focus = (): void => { void refresh(); };
    const visible = (): void => { if (document.visibilityState === 'visible') focus(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', visible);
    return () => {
      invalidateRequests();
      window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visible);
      if (loginRef.current || operating.current) void port?.relayBrowserCancel?.().catch(() => {});
      loginRef.current = null;
    };
  }, [port, refresh, invalidateRequests]);
  const previousServer = useRef(options.serverUrl);
  useEffect(() => {
    if (previousServer.current === options.serverUrl) return;
    previousServer.current = options.serverUrl;
    if (loginRef.current || operating.current) void cancel();
  }, [options.serverUrl, cancel]);

  return { phase, account, login, error, busy: ['checking', 'starting', 'cancelling', 'loggingout'].includes(phase), refresh, start, cancel, reopen, openCenter, logout, retry };
}
