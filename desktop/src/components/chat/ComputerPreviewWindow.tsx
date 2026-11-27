import { useEffect, useState, type ReactElement } from 'react'
import { AlertCircle, Info } from 'lucide-react'
import { PreviewImage } from './PreviewImage'
import { ComputerPreviewFooter } from './ComputerPreviewFooter'
import { PreviewActivity, PreviewStreamBadge } from './PreviewActivity'
import { useAppearance } from '../../settings/appearance-store'
import { isMacPlatform } from '../../utils/platform'
import {
  EMPTY_COMPUTER_PREVIEW,
  observeComputerPreview,
} from '../../host-adapter/computer-preview-window'
import '../../styles/components/computer-preview-window.css'

export function ComputerPreviewWindow(): ReactElement {
  useAppearance()
  const [state, setState] = useState(EMPTY_COMPUTER_PREVIEW)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    let off: (() => void) | undefined
    void observeComputerPreview((snapshot) => {
      if (!disposed) {
        setState(snapshot)
        setError('')
      }
    })
      .then((unsubscribe) => {
        if (disposed) unsubscribe()
        else off = unsubscribe
      })
      .catch((err) => {
        if (!disposed) setError(String(err))
      })
    return () => {
      disposed = true
      off?.()
    }
  }, [])
  const windowSelection = isMacPlatform()
  const currentAction = state.action ?? state.actions?.at(-1)
  // A terminal task snapshot must not keep an older action spinning.
  const status = ['失败', '已中断', '已停止'].includes(state.status)
    ? state.status
    : (currentAction?.status ?? state.status)
  const actionTitle = (currentAction?.title ?? state.title).replace(/^正在/, '')
  const title =
    status === '已完成'
      ? `${actionTitle}已完成`
      : status === '失败'
        ? `${actionTitle}失败`
        : status === '已中断'
          ? '操作已中断'
          : status === '已停止'
            ? '任务已停止'
            : status === '待执行'
              ? `准备${actionTitle}`
              : status === '等待工具操作'
                ? (windowSelection ? '实时窗口预览' : '等待电脑操作')
                : actionTitle
  const activityAction = currentAction
    ? {
        ...currentAction,
        title,
        status,
        target: currentAction.target ?? '',
      }
    : undefined
  const history = (state.actions?.filter((action) => action.id !== currentAction?.id) ?? []).map(
    (action) =>
      ['已中断', '已停止'].includes(status) && ['执行中', '待执行'].includes(action.status)
        ? { ...action, status }
        : action,
  )
  const streamState = error ? 'error' : (state.streamState ?? 'stopped')
  const streamError = error
    ? '无法连接电脑画面，请查看连接详情。'
    : streamState === 'error'
      ? state.streamDetail || '画面连接已断开，暂时无法接收新画面。'
      : ''
  const timestamp = state.updatedAt ?? state.screenshotAt
  const streamLabel =
    streamState === 'running'
      ? '实时'
      : streamState === 'starting'
        ? '连接中'
        : streamState === 'error'
          ? '连接失败'
          : state.dataUrl
            ? '画面已保留'
            : (windowSelection ? '等待选择窗口' : '等待工具')
  return (
    <main className="computer-preview-window" aria-label="电脑观察窗">
      <header>
        <PreviewActivity
          action={activityAction}
          title={title}
          status={status}
          detail={status === '失败' ? state.detail || '操作未完成，请查看目标窗口。' : undefined}
        />
        <PreviewStreamBadge state={streamState} retained={Boolean(state.dataUrl)}
          waitingLabel={windowSelection ? '等待选择窗口' : undefined} />
        <details key={`details:${state.scope ?? ''}`} className="computer-preview-window__details">
          <summary aria-label="画面与操作详情" title="画面与操作详情">
            <Info size={16} />
          </summary>
          <div className="computer-preview-window__details-panel">
            <dl>
              <dt>画面连接</dt>
              <dd>{streamLabel}</dd>
              {(!windowSelection || Boolean(currentAction)) && <><dt>工具操作</dt><dd>{status}</dd></>}
              {state.frameGeometry && (
                <>
                  <dt>源图尺寸</dt>
                  <dd>
                    {state.frameGeometry.width} × {state.frameGeometry.height}
                  </dd>
                </>
              )}
              {timestamp !== undefined && (
                <>
                  <dt>最后更新</dt>
                  <dd>{new Date(timestamp).toLocaleTimeString()}</dd>
                </>
              )}
            </dl>
            <p>{windowSelection ? '关闭预览会停止采集。' : '这是观察窗口。关闭窗口不会停止任务。'}</p>
            <p>100% 查看原始细节，适应用于查看全局。</p>
            {state.streamDetail && <p>画面：{state.streamDetail}</p>}
            {status === '失败' && state.detail && <p>操作：{state.detail}</p>}
            {error && <p>连接详情：{error}</p>}
          </div>
        </details>
      </header>
      <div className="computer-preview-window__picture">
        {streamError && (
          <div className="computer-preview-window__notice" role="alert">
            <AlertCircle size={14} />
            <span>
              {streamError}
              {status === '执行中' ? ' 工具仍在执行。' : ''}
            </span>
          </div>
        )}
        <PreviewImage
          key={state.scope}
          src={state.dataUrl}
          alt={streamState === 'running' ? '电脑控制实时画面' : '电脑控制最后画面'}
          empty={
            streamState === 'starting'
              ? '正在连接电脑画面'
              : streamState === 'error'
                ? '电脑画面连接失败'
                : (windowSelection ? '等待选择窗口' : '等待电脑操作')
          }
          emptyDescription={
            windowSelection
              ? (state.streamDetail || '点击主窗口的实时窗口预览按钮选择窗口。')
              : streamState === 'starting'
              ? '工具已开始，收到画面后会自动显示。'
              : streamState === 'error'
                ? '连接恢复后会自动更新，工具状态见上方。'
                : '工具开始操作电脑后，画面会在这里显示。'
          }
          toolbarPosition="bottom"
          renderToolbar={toolbar => (
            <ComputerPreviewFooter toolbar={toolbar} actions={history} />
          )}
          action={currentAction ? { ...currentAction, status } : undefined}
          frameGeometry={state.frameGeometry}
        />
      </div>
    </main>
  )
}
