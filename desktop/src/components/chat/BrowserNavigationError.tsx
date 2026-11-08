import { Globe, RotateCw } from 'lucide-react';
import type { NativeBrowserNavigationError } from '../../host-adapter/native-browser';

export function BrowserNavigationError({ failure, onRetry, onEdit }: {
  readonly failure: NativeBrowserNavigationError;
  readonly onRetry: () => void;
  readonly onEdit: () => void;
}): JSX.Element {
  let host = '此网站';
  try { host = new URL(failure.url).host || host; } catch { /* The recorded URL remains available below. */ }
  const dns = failure.code === 'ERR_NAME_NOT_RESOLVED';
  return <div className="browser-navigation-error" role="alert">
    <div className="browser-navigation-error__mark"><Globe size={28} strokeWidth={1.25} aria-hidden="true" /></div>
    <h2>无法打开网页</h2>
    <p>{dns ? `找不到 ${host} 的服务器地址，请确认网址是否完整。` : '网页未能加载，请检查连接后重试。'}</p>
    <span className="browser-navigation-error__url" title={failure.url}>{failure.url}</span>
    <div className="browser-navigation-error__actions"><button type="button" onClick={onRetry}><RotateCw size={13} />重试</button><button type="button" onClick={onEdit}>修改网址</button></div>
    {failure.code && <code>{failure.code}</code>}
  </div>;
}
