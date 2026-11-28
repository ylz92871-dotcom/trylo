import type { ReactElement } from 'react'
import { AlertCircle, Check, Loader2, Circle } from 'lucide-react'
import type { PreviewAction } from '../../tooling/tool-preview-state'

import type { ComputerPreviewStatusEvent } from '../../services-host/methods'

export type PreviewStreamState = ComputerPreviewStatusEvent['state']

const streamLabels = {
  starting: '正在连接',
  selecting: '等待选窗',
  running: '实时预览',
  error: '连接失败',
} as const

export function PreviewStreamBadge({ state, retained = false, waitingLabel = '等待工具' }: {
  readonly state: PreviewStreamState; readonly retained?: boolean; readonly waitingLabel?: string
}): ReactElement {
  const label = state === 'stopped' ? (retained ? '画面已保留' : waitingLabel) : streamLabels[state]
  return <span className="tool-preview-badge" data-state={state} aria-live="polite">{state === 'starting' ? <Loader2 size={11} className="preview-actions__spin" /> : <i />}{label}</span>
}

export function PreviewActivity({ action, title, status, detail }: {
  readonly action?: PreviewAction
  readonly title: string
  readonly status: string
  readonly detail?: string
}): ReactElement {
  const currentStatus = action?.status ?? status
  const running = currentStatus === '执行中'
  const failed = currentStatus === '失败'
  const currentTitle = action?.title ?? title
  return <div className="preview-activity" data-status={currentStatus} role="status" aria-live="polite">
    <span className="preview-activity__icon">{running ? <Loader2 size={16} className="preview-actions__spin" /> : failed ? <AlertCircle size={16} /> : currentStatus === '已完成' ? <Check size={16} /> : <Circle size={16} />}</span>
    <div><strong>{running && !currentTitle.startsWith('正在') ? `正在${currentTitle}` : currentTitle}</strong>{failed && detail ? <small title={detail}>{detail}</small> : action?.target ? <small title={action.target}>{action.target}</small> : detail ? <small title={detail}>{detail}</small> : null}</div>
    <span className="tool-preview-status" data-status={currentStatus}>{currentStatus}</span>
  </div>
}
