import { useEffect, useId, useRef, useState } from 'react'
import {
  contextWindowOptions,
  resolveContextPreference,
  validContextSize,
  type ModelContextPreference,
} from '../../settings/context-window'

export interface ContextWindowFieldsProps {
  readonly preference: ModelContextPreference
  readonly serverCapacity?: number
  readonly onChange: (preference: ModelContextPreference) => void
  readonly capacityEditable?: boolean
}

const label = (n: number): string => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}K`)

export function ContextWindowFields({
  preference,
  serverCapacity,
  onChange,
  capacityEditable = true,
}: ContextWindowFieldsProps): JSX.Element {
  const id = useId()
  const [capacityText, setCapacityText] = useState(preference.capacity?.toString() ?? '')
  const capacityInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setCapacityText(preference.capacity?.toString() ?? '')
    capacityInput.current?.setCustomValidity('')
  }, [preference.capacity])
  const resolved = resolveContextPreference(preference, serverCapacity)
  const automatic = resolveContextPreference({ ...preference, window: undefined }, serverCapacity)
  return (
    <div className="context-window-fields">
      <label className="settings-modal__field">
        <span className="settings-modal__label">上下文窗口</span>
        <select
          className="settings-modal__input"
          value={preference.window === undefined ? 'auto' : String(preference.window)}
          onChange={(event) =>
            onChange({
              ...preference,
              window: event.target.value === 'auto' ? undefined : Number(event.target.value),
            })
          }
        >
          <option value="auto">{capacityEditable ? '自动 · 默认 200K' : `自动 · ${label(automatic.effective)}`}</option>
          {preference.window !== undefined &&
            !contextWindowOptions(preference, serverCapacity).includes(preference.window) && (
              <option value={preference.window} disabled>
                {label(preference.window)}（按上限执行）
              </option>
            )}
          {contextWindowOptions(preference, serverCapacity).map((size) => (
            <option key={size} value={size}>
              {!capacityEditable && size === serverCapacity ? `最大 · ${size.toLocaleString('en-US')} tokens` : label(size)}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-modal__hint" aria-live="polite">
        实际使用 {capacityEditable ? label(resolved.effective) : `${resolved.effective.toLocaleString('en-US')} tokens`} ·{' '}
        {!capacityEditable ? '按已同步的服务容量限制' : resolved.capacity === undefined
          ? '模型容量未声明'
          : `模型或服务端上限 ${label(resolved.capacity)}`}
        。
      </p>
      {capacityEditable && <details className="context-window-fields__capacity">
        <summary>设置模型容量</summary>
        <label className="settings-modal__field" htmlFor={id}>
          <span className="settings-modal__label">模型或服务端上限（tokens）</span>
          <input
            ref={capacityInput}
            id={id}
            className="settings-modal__input"
            type="number"
            min="1"
            step="1"
            value={capacityText}
            placeholder="可选，如 128000、1000000"
            onChange={(event) => {
              const raw = event.target.value
              setCapacityText(raw)
              const capacity = raw === '' ? undefined : validContextSize(Number(raw))
              event.target.setCustomValidity(
                raw !== '' && capacity === undefined ? '请输入正整数 token 数量。' : '',
              )
              if (raw === '' || capacity !== undefined) {
                onChange({
                  ...preference,
                  capacity,
                  // Typing "128000" passes through "1", "12", etc. Keep the
                  // requested window; only the effective budget follows the cap.
                })
              }
            }}
          />
        </label>
        <p className="settings-modal__hint">
          按服务商公布的容量填写；已知服务端上限仍会限制可用窗口。
        </p>
      </details>}
    </div>
  )
}
