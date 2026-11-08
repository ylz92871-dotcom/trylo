import type { TryloSettings } from '../../settings/settings-store'
import {
  parseReasoningEffort,
  reasoningChoices,
  reasoningSelectionProblem,
  REASONING_LABELS,
} from '../../settings/reasoning-effort'

export function ReasoningEffortField({
  form,
  onChange,
}: {
  form: TryloSettings
  onChange: (value: TryloSettings['reasoningEffort']) => void
}): JSX.Element {
  const choices = reasoningChoices(form.apiModel)
  const invalid = reasoningSelectionProblem(form)
  const unlisted =
    form.reasoningEffort !== undefined && !choices.levels.includes(form.reasoningEffort)
  return (
    <div className="settings-modal__field">
      <label className="settings-modal__label" htmlFor="primary-reasoning-effort">
        思考强度
      </label>
      <select
        id="primary-reasoning-effort"
        className="settings-modal__input"
        value={form.reasoningEffort ?? ''}
        aria-invalid={!!invalid}
        aria-describedby="primary-reasoning-hint primary-reasoning-scope"
        onChange={(event) => onChange(parseReasoningEffort(event.target.value))}
      >
        <option value="">跟随服务商（默认）</option>
        {unlisted && form.reasoningEffort && (
          <option value={form.reasoningEffort} disabled>
            {REASONING_LABELS[form.reasoningEffort]}（当前模型不支持）
          </option>
        )}
        {choices.levels.map((level) => (
          <option key={level} value={level}>
            {REASONING_LABELS[level]}（{level}）
          </option>
        ))}
      </select>
      <span id="primary-reasoning-hint" className="settings-modal__hint">
        {choices.hint}
      </span>
      <span id="primary-reasoning-scope" className="settings-modal__hint">
        影响每次模型请求的推理投入，保存后从下一次请求生效。跟随服务商不代表低档。
      </span>
      {invalid && (
        <span role="alert" className="settings-modal__hint">
          {invalid}
        </span>
      )}
    </div>
  )
}
