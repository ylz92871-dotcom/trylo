import { useId, useState } from 'react'
import { usePlatformModels } from '../../account/use-platform-models'
import type { TryloSettings } from '../../settings/settings-store'
import {
  contextModelKey,
  contextPreference,
  withContextPreference,
  type ContextModelIdentity,
  type ModelContextPreferences,
} from '../../settings/context-window'
import { ContextWindowFields } from './ContextWindowFields'
import { amdReasoningChoices, amdReasoningLabel, type ModelReasoningPreferences } from '../../settings/model-reasoning'
import { parseReasoningEffort, REASONING_LABELS } from '../../settings/reasoning-effort'

interface ContextTarget {
  readonly id: string
  readonly label: string
  readonly identity: ContextModelIdentity
  readonly capacity?: number
}

export interface ModelContextSettingsProps {
  readonly form: TryloSettings
  readonly onChange: (preferences: ModelContextPreferences) => void
  readonly onReasoningChange?: (preferences: ModelReasoningPreferences) => void
}

/** Configure model preferences without changing the active connection. */
export function ModelContextSettings({ form, onChange, onReasoningChange }: ModelContextSettingsProps): JSX.Element {
  const catalog = usePlatformModels(true)
  const reasoningId = useId()
  const [targetId, setTargetId] = useState(
    form.poolModel.trim() ? `pool:${form.poolModel.trim()}` : 'configured',
  )
  const targets: ContextTarget[] = [
    {
      id: 'configured',
      label: `当前连接 · ${form.apiModel || '默认模型'}`,
      identity: { ...form, poolModel: '' },
    },
    ...form.modelProfiles.map((profile) => ({
      id: `profile:${profile.id}`,
      label: `${profile.name} · ${profile.apiModel || '默认模型'}`,
      identity: { ...profile, poolModel: '' },
    })),
    ...catalog.models.map((model) => ({
      id: `pool:${model.id}`,
      label: `免费模型 · ${model.id}`,
      identity: { poolModel: model.id },
      capacity: model.contextLength,
    })),
  ]
  // Keep the current pool editable while its authorized catalog is loading/offline.
  const poolModel = form.poolModel.trim()
  if (poolModel && !targets.some((target) => target.id === `pool:${poolModel}`)) {
    targets.push({
      id: `pool:${poolModel}`,
      label: `免费模型 · ${poolModel}`,
      identity: { poolModel },
    })
  }
  const target = targets.find((item) => item.id === targetId) ?? targets[0]!
  const context = { ...target.identity, modelContextPreferences: form.modelContextPreferences }
  const isPool = Boolean(target.identity.poolModel)
  const key = contextModelKey(context)
  const effort = form.modelReasoningPreferences?.[key] ?? 'default'
  const reasoning = amdReasoningChoices(target.identity.poolModel ?? '')
  const unlisted = effort !== 'default' && !reasoning.levels.includes(effort)
  return (
    <fieldset className="settings-modal__group model-run-settings">
      <legend className="settings-modal__legend">模型运行设置</legend>
      <p className="settings-modal__desc">选择模型，调整它的上下文与思考方式。每个模型单独记住，保存后从下次请求生效。</p>
      <label className="settings-modal__field">
        <span className="settings-modal__label">配置模型</span>
        <select
          className="settings-modal__input"
          value={target.id}
          onChange={(event) => setTargetId(event.target.value)}
        >
          {targets.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {isPool && <div className="model-run-settings__summary">
        <span>Trylo 免费池</span>
        <span>{target.capacity ? `AMD 容量 ${target.capacity.toLocaleString('en-US')} tokens` : catalog.loading ? '正在同步 AMD 容量…' : '暂未取得服务端容量'}</span>
      </div>}
      <div className={isPool ? 'model-run-settings__controls' : undefined}>
        <ContextWindowFields
          key={key}
          preference={contextPreference(context)}
          serverCapacity={target.capacity}
          capacityEditable={!isPool}
          onChange={(preference) => onChange(withContextPreference(context, preference))}
        />
        {isPool && <div className="settings-modal__field">
          <label className="settings-modal__label" htmlFor={reasoningId}>思考强度</label>
          <select id={reasoningId} aria-label="免费模型思考强度" className="settings-modal__input"
            value={effort} disabled={form.cliRuntimeProtocol !== 'trylo-v1' || (!reasoning.levels.length && !unlisted) || !onReasoningChange}
            aria-invalid={unlisted} aria-describedby={`${reasoningId}-hint`}
            onChange={event => onReasoningChange?.({ ...form.modelReasoningPreferences, [key]: parseReasoningEffort(event.target.value) ?? 'default' })}>
            <option value="default">跟随服务商</option>
            {unlisted && <option value={effort} disabled>{REASONING_LABELS[effort]}（当前不支持）</option>}
            {reasoning.levels.map(level => <option key={level} value={level}>{amdReasoningLabel(target.identity.poolModel ?? '', level)} · {level}</option>)}
          </select>
          <span id={`${reasoningId}-hint`} className="settings-modal__hint">{reasoning.hint}</span>
          {unlisted && <span role="alert" className="settings-modal__hint">请选择该 AMD 模型支持的档位。</span>}
        </div>}
      </div>
      {isPool && !catalog.loading && catalog.message && <p role="status" className="settings-modal__hint">{catalog.message}</p>}
    </fieldset>
  )
}
