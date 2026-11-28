import { useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { ServiceRequestError } from '../../services-host/services-client';
import type { ToolPlatformState } from '../../tooling/use-tool-platform-state';

export function WorkspaceSkillInstall({ workspaceRoot, query, connected, needsReload, onInstalled }: {
  readonly workspaceRoot?: string;
  readonly query?: ToolPlatformState['workspaceSkills'];
  readonly connected: boolean;
  readonly needsReload?: boolean;
  readonly onInstalled: () => void;
}): ReactElement {
  const inputId = useId();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [installed, setInstalled] = useState('');
  const inFlight = useRef(false);
  async function install(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const source = url.trim();
    if (!source || inFlight.current) return;
    setError('');
    setInstalled('');
    if (!workspaceRoot) {
      setError('请先打开一个工作区，再安装 Skill。');
      return;
    }
    if (needsReload) {
      setError('请点「重载服务」，然后重新提交这个链接。');
      return;
    }
    if (!query) {
      setError('技能安装入口尚未加载，请刷新 Trylo 后重试。');
      return;
    }

    inFlight.current = true;
    setBusy(true);
    try {
      const result = await query({ op: 'install', url: source, workspaceRoot });
      if (!result.ok || !result.installed) {
        setError(result.error ?? '安装失败，请重试。');
        return;
      }
      setInstalled(result.installed.name);
      setUrl('');
      onInstalled();
    } catch (cause) {
      setError(cause instanceof ServiceRequestError && cause.code === 'UNKNOWN_METHOD'
        ? '当前工具服务版本不支持链接安装。请重载工具服务后重试。'
        : '工具服务未能完成安装，请检查连接后重试。');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="left-rail__skill-install" onSubmit={event => void install(event)} aria-labelledby={inputId + '-label'}>
      <label id={inputId + '-label'} htmlFor={inputId}>从 URL 安装 Skill</label>
      <div className="left-rail__skill-install-row">
        <input id={inputId} className="left-rail__search-input" name="skill-url" type="url"
          autoComplete="off" spellCheck={false} required value={url} placeholder="https://…"
          readOnly={busy} aria-invalid={Boolean(error)}
          aria-describedby={inputId + '-help' + (error ? ' ' + inputId + '-error' : '')}
          onChange={event => { setUrl(event.target.value); setError(''); setInstalled(''); }} />
        <button type="submit" className="left-rail__tool-action"
          disabled={busy}>{busy ? '安装中…' : '安装'}</button>
      </div>
      <p id={inputId + '-help'}>
        {!workspaceRoot ? '先打开一个工作区。'
          : needsReload ? '可先录入链接，重载工具服务后安装。'
            : !query ? '可先录入链接，等待安装入口加载。'
              : !connected ? '提交时会连接工具服务。'
                : '支持 GitHub 技能目录和 SKILL.md 直链，安装到当前工作区。'}
      </p>
      {error && <p id={inputId + '-error'} role="alert" className="left-rail__skill-install-error">{error}</p>}
      <div role="status">{installed ? '已安装 ' + installed : ''}</div>
    </form>
  );
}
