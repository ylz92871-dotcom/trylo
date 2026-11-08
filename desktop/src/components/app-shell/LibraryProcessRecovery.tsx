import { useSyncExternalStore } from 'react';
import type { CliCommandRecoveryPort, CliCommandRetainedStatus } from '../../host-adapter/cli-command';
import './desktop-libraries.css';

/** Projection only: the existing Supervisor retains the handle and performs every retry. */
export function LibraryProcessRecovery({ port, floating = false }: { readonly port: CliCommandRecoveryPort; readonly floating?: boolean }) {
  useSyncExternalStore(port.subscribe, port.getVersion);
  const statuses = port.statuses();
  if (statuses.length === 0) return null;
  const workspaces = new Map<string, CliCommandRetainedStatus[]>();
  for (const status of statuses) {
    const group = workspaces.get(status.workspaceRoot) ?? [];
    group.push(status);
    workspaces.set(status.workspaceRoot, group);
  }
  return <aside className={`desktop-library-recovery${floating ? ' desktop-library-recovery--floating' : ''}`} aria-label="库进程停止状态">
    {Array.from(workspaces, ([workspaceRoot, group]) => {
      const failed = group.filter(status => status.state === 'stop_unconfirmed');
      return <section key={workspaceRoot} role={failed.length > 0 ? 'alert' : 'status'}>
        <p className="desktop-library-recovery__title">{failed.length > 0 ? '库操作尚未确认停止' : '正在停止库操作…'}{group.length > 1 && <span>（{group.length} 项）</span>}</p>
        <p className="desktop-library-recovery__workspace">工作区：{workspaceRoot}</p>
        {failed.length > 0 ? <>
          <p className="desktop-library-recovery__hint">请重试停止，确认结束后即可继续使用库。</p>
          <button type="button" className="settings-modal__btn settings-modal__btn--ghost"
            onClick={() => { for (const status of failed) void port.retry(status.processId).catch(() => { /* The owner retains and displays the failed retry. */ }); }}>重试停止</button>
        </> : <p className="desktop-library-recovery__hint">结束后此提示会自动消失。</p>}
        {failed.some(status => status.error) && <details><summary>诊断信息</summary>{failed.map(status => <code key={status.processId}>{status.processId}: {status.error ?? '尚未收到退出确认'}</code>)}</details>}
      </section>;
    })}
  </aside>;
}
