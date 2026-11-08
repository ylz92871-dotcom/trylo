import { useCallback, useEffect, useRef, useState } from 'react'
import {
  controlCentralRuntime,
  type CentralRuntimeState,
} from '../../agent-learning/central-runtime'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'

const states = {
  running: '正在学习',
  waiting: '等待有意义的继续机会',
  stopping: '正在停止',
  stopped: '已停止',
  failed: '运行需要检查',
}
type RuntimeAction = 'inspect' | 'stop' | 'resume'

function observedStatus(value: CentralRuntimeState, confirmedStop: boolean): string {
  if (value.owner?.state === 'stopping') return '后台正在停止，请刷新确认退出。'
  if (value.enabled) {
    if (value.owner)
      return `${value.owner.state === 'running' && value.owner.progress?.phase === 'initializing' ? '正在初始化学习运行时' : states[value.owner.state]}。`
    return value.configuration
      ? '已启用学习，下一次正常入口将恢复后台。'
      : '已启用学习，但尚未读到有效的可恢复配置。'
  }
  if (value.owner) return '停止请求已保存，后台退出状态仍需刷新确认。'
  if (value.configuration) return '学习已停止，可恢复原配置。'
  return confirmedStop
    ? '学习已停止，但未读到可恢复配置，请刷新核对。'
    : '尚未启用学习，尚无可恢复配置。'
}
/** Reports the actual workspace owner, including activation that originated in CLI. */
export function CentralRuntimeStatus(props: {
  readonly runtime?: ToolLearningRuntime
  readonly onEnabledChange?: (enabled: boolean) => void
  readonly onState?: (state: CentralRuntimeState) => void
}) {
  const [value, setValue] = useState<CentralRuntimeState>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const runtime = props.runtime
  const runtimeRef = useRef(runtime),
    request = useRef<AbortController>()
  const knownConfiguration = useRef<CentralRuntimeState['configuration']>(),
    confirmedStop = useRef(false)
  const callbacks = useRef({ onState: props.onState, onEnabledChange: props.onEnabledChange })
  runtimeRef.current = runtime
  callbacks.current = { onState: props.onState, onEnabledChange: props.onEnabledChange }
  const accept = useCallback((next: CentralRuntimeState, action: RuntimeAction) => {
    // Inspect is authoritative. Control replies may omit the saved configuration.
    if (action === 'inspect' || next.configuration !== undefined)
      knownConfiguration.current = next.configuration
    if (action === 'stop') confirmedStop.current = true
    else if (action === 'resume' || next.enabled) confirmedStop.current = false
    const accepted =
      next.configuration === undefined && action !== 'inspect' && knownConfiguration.current
        ? { ...next, configuration: knownConfiguration.current }
        : next
    setValue(accepted)
    callbacks.current.onState?.(accepted)
  }, [])
  useEffect(() => {
    const selected = runtimeRef.current
    setValue(undefined)
    setBusy(false)
    setError('')
    knownConfiguration.current = undefined
    confirmedStop.current = false
    if (selected === undefined) return
    const abort = new AbortController()
    request.current?.abort()
    request.current = abort
    void controlCentralRuntime(selected, 'inspect', abort.signal).then(
      (next) => {
        if (!abort.signal.aborted) accept(next, 'inspect')
      },
      (failure) => {
        if (!abort.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'central_runtime_unavailable')
      },
    )
    return () => {
      abort.abort()
      request.current?.abort()
    }
  }, [runtime?.process, runtime?.cliPath, runtime?.nodeProgram, runtime?.cwd, accept])
  const control = async (action: RuntimeAction) => {
    const selected = runtimeRef.current
    if (selected === undefined) return
    const abort = new AbortController()
    request.current?.abort()
    request.current = abort
    setBusy(true)
    setError('')
    try {
      const next = await controlCentralRuntime(selected, action, abort.signal)
      if (abort.signal.aborted) return
      accept(next, action)
      if (action !== 'inspect') callbacks.current.onEnabledChange?.(next.enabled)
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'central_runtime_unavailable')
    } finally {
      if (!abort.signal.aborted) setBusy(false)
    }
  }
  const observed = value ? observedStatus(value, confirmedStop.current) : ''
  const stopping = value?.owner?.state === 'stopping'
  const canStop =
    !!runtime &&
    !busy &&
    !stopping &&
    (value?.enabled === true || (!!value?.owner && value.owner.state !== 'stopped'))
  const canResume =
    !!runtime && !busy && !error && value?.configuration !== undefined && value.owner === undefined
  const firstUse =
    value !== undefined &&
    !value.enabled &&
    !value.configuration &&
    !value.owner &&
    !confirmedStop.current &&
    !error
  return (
    <div aria-label="当前工作区学习运行状态">
      <p className="settings-modal__hint" role="status">
        {!runtime
          ? '学习运行时尚未就绪。'
          : error
            ? `当前工作区：状态尚未确认。${observed ? `上次读取：${observed}` : ''}`
            : !value
              ? '尚未读到工作区后台状态。'
              : `当前工作区：${observed}`}
      </p>
      {firstUse && (
        <p className="settings-modal__hint">
          开启并保存中央学习系统（测试功能）后，在下次普通任务中首次启动后台。当前没有可恢复配置。
        </p>
      )}
      {value?.enabled && (
        <p className="settings-modal__hint">
          这是 CLI 与 Desktop 共用的实际状态；已有 CLI 授权也会在这里显示。
        </p>
      )}
      {value?.configuration && (
        <p className="settings-modal__hint">
          后台连接：{value.configuration.providerId} / {value.configuration.model}
          {value.configuration.accountId ? `（账户 ${value.configuration.accountId}）` : ''}
          ；用户学习{value.configuration.userLearning ? '已启用' : '已关闭'}。
        </p>
      )}
      {value?.configuration &&
        (value.configuration.thoughtMaxTokens ?? value.configuration.allowance?.maxTokens) !==
          undefined && (
          <p className="settings-modal__hint">
            当前保存的中央单次思考包络：
            {(
              value.configuration.thoughtMaxTokens ?? value.configuration.allowance?.maxTokens
            )?.toLocaleString()}{' '}
            token
            {value.configuration.thoughtMaxTokens === undefined ? '（沿初始配置）' : ''}
            。表单草稿在明确编辑并保存后生效。
          </p>
        )}
      {error && (
        <p className="settings-modal__hint" role="alert">
          未确认运行状态或控制结果：{error}
        </p>
      )}
      <div
        role="group"
        aria-label="工作区学习控制"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
      >
        <button
          type="button"
          className="settings-modal__btn settings-modal__btn--ghost"
          disabled={!runtime || busy}
          onClick={() => void control('inspect')}
        >
          刷新运行状态
        </button>
        <button
          type="button"
          className="settings-modal__btn"
          disabled={!canStop}
          onClick={() => void control('stop')}
        >
          停止工作区学习
        </button>
        <button
          type="button"
          className="settings-modal__btn settings-modal__btn--primary"
          disabled={!canResume}
          title={
            canResume ? '恢复已保存的工作区学习配置' : '需先确认原配置存在且原后台已退出，才能恢复'
          }
          onClick={() => void control('resume')}
        >
          恢复已有学习
        </button>
      </div>
    </div>
  )
}
