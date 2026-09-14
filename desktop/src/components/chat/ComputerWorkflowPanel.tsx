// Trylo Desktop — ComputerWorkflowPanel
//
// Windows-MCP whitelist only (11 tools). WatchDog off, screenshots
// capped 1920×1080, no persistence. Fully auto mode: medium actions
// show AutoNotice countdown, high-risk still blocks via ApprovalCard.

import { memo, type ReactElement } from 'react'
import { AutoNotice } from './AutoNotice'
import { WINDOWS_TOOL_NAMES } from '../../tooling/classifiers/windows-mcp-classifier'

export interface ComputerWorkflowPanelProps {
  readonly action: string
  readonly target?: string
  readonly status: 'running' | 'done'
  readonly displayInfo?: string
  readonly autoMode?: boolean
}

function ComputerWorkflowPanelImpl(props: ComputerWorkflowPanelProps): ReactElement {
  return (
    <div className="work-activities" role="listitem" aria-label="电脑控制 · 白名单会话">
      <div className="work-activities__head" style={{ cursor: 'default' } as React.CSSProperties}>
        <span className="work-activities__head-summary">
          电脑控制 · {props.action}
          {props.target ? ` · ${props.target}` : ''}
        </span>
      </div>
      {props.displayInfo ? (
        <div className="auto-notice auto-notice--info">
          <span className="auto-notice__detail">
            {props.displayInfo} · 截图上限 1920×1080 · 不持久化
          </span>
        </div>
      ) : null}
      <AutoNotice
        id={`computer:${props.action}:${props.target ?? ''}`}
        tone="warn"
        title={`${props.action} 已执行`}
        detail={
          props.autoMode
            ? `受控 ${WINDOWS_TOOL_NAMES.length} 工具白名单 · 将于 3s 后自动继续`
            : `受控 ${WINDOWS_TOOL_NAMES.length} 工具白名单`
        }
        autoContinueMs={props.autoMode ? 3000 : 0}
      />
    </div>
  )
}

export const ComputerWorkflowPanel = memo(ComputerWorkflowPanelImpl)
