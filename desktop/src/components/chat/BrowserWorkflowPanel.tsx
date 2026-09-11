// Trylo Desktop — BrowserWorkflowPanel
//
// Simple linear UI for Playwright MCP + chrome-devtools MCP.
// Controlled session, no user default profile, downloads gated to
// .trylo/out/. Uses same mono xs + 3px accent as WorkActivityGroup.

import { memo, type ReactElement } from 'react';
import { AutoNotice } from './AutoNotice';

export interface BrowserWorkflowPanelProps {
  readonly url?: string;
  readonly status: 'running' | 'done' | 'blocked';
  /** Download path when a file was saved */
  readonly downloadPath?: string;
  readonly autoMode?: boolean;
  readonly detail?: string;
}

function BrowserWorkflowPanelImpl(props: BrowserWorkflowPanelProps): ReactElement {
  return (
    <div className="work-activities" role="listitem" aria-label="浏览器 · 受控会话">
      <div className="work-activities__head" style={{ cursor: 'default' } as React.CSSProperties}>
        <span className="work-activities__head-summary">
          浏览器 · 受控会话{props.url ? ` · ${props.url}` : ''}
        </span>
      </div>
      <div className="auto-notice auto-notice--info">
        <span className="auto-notice__title">隔离浏览器会话</span>
        <span className="auto-notice__detail">不使用本机登录态 · 下载仅到 .trylo/out/</span>
      </div>
      {props.detail ? (
        <div className="auto-notice auto-notice--info">
          <span className="auto-notice__detail">{props.detail}</span>
        </div>
      ) : null}
      {props.downloadPath ? (
        <AutoNotice
          id={`browser:dl:${props.downloadPath}`}
          tone="info"
          title={`已下载 ${props.downloadPath}`}
          detail={props.autoMode ? '将于 3s 后自动继续' : undefined}
          autoContinueMs={props.autoMode ? 3000 : 0}
        />
      ) : null}
    </div>
  );
}

export const BrowserWorkflowPanel = memo(BrowserWorkflowPanelImpl);
