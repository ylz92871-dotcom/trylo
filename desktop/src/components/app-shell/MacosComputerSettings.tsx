import { useCallback, useEffect, useRef, useState } from 'react'
import type { MacosComputerPermission, MacosComputerPermissions } from '../../services-host/methods'
import type { ToolingFacade } from '../../tooling/tooling-facade'

export function MacosComputerSettings({ facade, value, onChange }: {
  readonly facade?: ToolingFacade | null
  readonly value?: boolean
  readonly onChange: (enabled: boolean) => void
}) {
  const [permissions, setPermissions] = useState<MacosComputerPermissions>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const epoch = useRef(0)
  const pending = useRef(false)
  const refresh = useCallback(async (request?: MacosComputerPermission) => {
    if (!facade || pending.current) return
    const generation = ++epoch.current
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const result = await facade.macosComputerPermissions(request)
      if (epoch.current === generation) setPermissions(result)
    } catch (error) {
      if (epoch.current === generation) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (epoch.current === generation) {
        pending.current = false
        setBusy(false)
      }
    }
  }, [facade])
  useEffect(() => {
    const detect = () => { void refresh() }
    detect()
    window.addEventListener('focus', detect)
    return () => {
      window.removeEventListener('focus', detect)
      epoch.current++
      pending.current = false
    }
  }, [refresh])
  const describe = (granted?: boolean) => granted === undefined ? '尚未检测' : granted ? '已授权' : '未授权'
  return (
    <fieldset className="settings-modal__group">
      <legend className="settings-modal__legend">macOS 电脑控制</legend>
      <label className="settings-modal__field settings-modal__field--inline">
        <input type="checkbox" name="macosComputerUse" checked={value ?? permissions?.enabledByEnvironment ?? false}
          onChange={event => onChange(event.target.checked)} />
        <span className="settings-modal__label">启用 Code 与 Work 的原生电脑控制</span>
      </label>
      <p className="settings-modal__hint">保存后用于新任务。默认优先通过辅助功能在后台无打扰操作，仅在应用不支持后台操作时提示切换前台；点击、键入和截图仍需通过任务的操作审批。</p>
      <div className="settings-modal__hint" aria-live="polite">
        <div>辅助功能：{describe(permissions?.accessibility)}</div>
        <div>鼠标与键盘事件：{describe(permissions?.postEvents)}</div>
        <div>屏幕录制：{describe(permissions?.screenRecording)}</div>
      </div>
      <div className="settings-modal__macos-permissions-actions">
        <button type="button" className="settings-modal__button" disabled={!facade || busy}
          onClick={() => { void refresh('accessibility') }}>请求辅助功能授权</button>
        <button type="button" className="settings-modal__button" disabled={!facade || busy}
          onClick={() => { void refresh('screen') }}>请求屏幕录制授权</button>
        <button type="button" className="settings-modal__button" disabled={!facade || busy}
          onClick={() => { void refresh() }}>{busy ? '正在检测权限…' : '重新检测'}</button>
      </div>
      {error && <p className="settings-modal__hint" role="alert">{error}</p>}
    </fieldset>
  )
}
