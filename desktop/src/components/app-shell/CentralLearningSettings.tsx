import { useEffect, useId, useRef, useState } from 'react'
import { agentLearningSettings, type AgentLearningSettings } from '../../settings/agent-learning'
import type { ToolLearningRuntime } from '../../tool-learning/cli-status'
import { CentralRuntimeStatus } from './CentralRuntimeStatus'

const valid = (value: string, maximum: number) =>
  /^\d+$/.test(value) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= 1 &&
  Number(value) <= maximum

/** Authorization settings only. The original CLI Board owns occupation and balance. */
export function CentralLearningSettings(props: {
  readonly value: AgentLearningSettings | undefined
  readonly onChange: (value: AgentLearningSettings) => void
  readonly onThoughtEdit?: () => void
  readonly runtime?: ToolLearningRuntime
}) {
  const value = agentLearningSettings(props.value),
    hintId = useId()
  const [tokens, setTokens] = useState(String(value.centralTokens))
  const [calls, setCalls] = useState(String(value.centralCalls))
  const [thought, setThought] = useState(
    value.centralThoughtMaxTokens === undefined ? '' : String(value.centralThoughtMaxTokens),
  )
  const thoughtEdited = useRef(false)
  const savedThought = useRef<string>(),
    lastValidThought = useRef(thought)
  useEffect(() => setTokens(String(value.centralTokens)), [value.centralTokens])
  useEffect(() => setCalls(String(value.centralCalls)), [value.centralCalls])
  useEffect(() => {
    if (!thoughtEdited.current && savedThought.current !== undefined) return
    const next =
      value.centralThoughtMaxTokens === undefined ? '' : String(value.centralThoughtMaxTokens)
    lastValidThought.current = next
    setThought(next)
  }, [value.centralThoughtMaxTokens])
  const tokensValid = valid(tokens, 1000000000),
    callsValid = valid(calls, 64)
  return (
    <fieldset className="settings-modal__group">
      <legend className="settings-modal__legend">中央学习系统 · 测试功能</legend>
      <p className="settings-modal__desc">
        测试功能，默认关闭，可自主选择开启或关闭。开启后，中央统一安排用户学习与 Agent
        各学习子系统，在任务结束后也可继续学习或等待；关闭并保存会停止当前工作区的中央学习后台，保留已有经验。用户学习的采集与政策应用仍由其独立设置控制。
      </p>
      <label className="settings-modal__field settings-modal__field--inline">
        <input
          type="checkbox"
          checked={value.centralEnabled}
          onChange={(event) => props.onChange({ ...value, centralEnabled: event.target.checked })}
        />
        <span className="settings-modal__label">启用中央学习系统（测试功能）</span>
      </label>
      <CentralRuntimeStatus
        runtime={props.runtime}
        onEnabledChange={(enabled) => props.onChange({ ...value, centralEnabled: enabled })}
        onState={(state) => {
          const saved =
            state.configuration?.thoughtMaxTokens ?? state.configuration?.allowance?.maxTokens
          if (!thoughtEdited.current && saved !== undefined) {
            savedThought.current = String(saved)
            lastValidThought.current = String(saved)
            setThought(String(saved))
          }
        }}
      />
      <label className="settings-modal__field">
        <span className="settings-modal__label">首次启用 token 累计授权</span>
        <input
          type="number"
          min={1}
          max={1000000000}
          step={1}
          className="settings-modal__input"
          value={tokens}
          disabled={!value.centralEnabled}
          aria-invalid={!tokensValid}
          aria-describedby={hintId}
          onChange={(event) => {
            const next = event.target.value
            setTokens(next)
            if (valid(next, 1000000000)) props.onChange({ ...value, centralTokens: Number(next) })
          }}
          onBlur={() => setTokens(String(value.centralTokens))}
        />
      </label>
      <label className="settings-modal__field">
        <span className="settings-modal__label">首次启用模型调用授权</span>
        <input
          type="number"
          min={1}
          max={64}
          step={1}
          className="settings-modal__input"
          value={calls}
          disabled={!value.centralEnabled}
          aria-invalid={!callsValid}
          aria-describedby={hintId}
          onChange={(event) => {
            const next = event.target.value
            setCalls(next)
            if (valid(next, 64)) props.onChange({ ...value, centralCalls: Number(next) })
          }}
          onBlur={() => setCalls(String(value.centralCalls))}
        />
      </label>
      <label className="settings-modal__field">
        <span className="settings-modal__label">中央单次思考 token 包络</span>
        <input
          type="number"
          min={1}
          max={1000000000}
          step={1}
          className="settings-modal__input"
          value={thought}
          aria-invalid={thought !== '' && !valid(thought, 1000000000)}
          aria-describedby={hintId}
          placeholder="留空沿用原初始包络"
          onChange={(event) => {
            const next = event.target.value
            setThought(next)
            if (next === '' || valid(next, 1000000000)) {
              lastValidThought.current = next
              thoughtEdited.current = true
              props.onThoughtEdit?.()
              if (next === '') {
                const legacy = { ...value }
                delete legacy.centralThoughtMaxTokens
                props.onChange(legacy)
              } else props.onChange({ ...value, centralThoughtMaxTokens: Number(next) })
            }
          }}
          onBlur={() => {
            if (thought !== '' && !valid(thought, 1000000000)) setThought(lastValidThought.current)
          }}
        />
      </label>
      <p id={hintId} className="settings-modal__hint">
        仅用于首次建立当前工作区的预算。总 token 包含输入与输出，首次调用授权为 1–64
        次。已有预算请到“学习安排 → 累计授权管理”调整新的总上限；额度不随任务或对话重置。
      </p>
      <p className="settings-modal__hint">
        累计授权供中央、User 与 Agent
        共用，步骤总额与首次调用总额相同。单次思考包络包含完整输入与输出，仍受累计剩余限制；明确编辑后保存也可更新已有后台，留空沿用其原初始包络，不增加总授权。
      </p>
      {value.centralEnabled && (!tokensValid || !callsValid) && (
        <p role="status" className="settings-modal__hint">
          请输入有效整数：token 为 1–1,000,000,000，调用为 1–64。失焦时保留上次有效值。
        </p>
      )}
    </fieldset>
  )
}
