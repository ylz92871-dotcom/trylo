import type { TryloSettings } from '../../settings/settings-store';
import { parseReasoningEffort, reasoningChoices, reasoningSelectionProblem, REASONING_LABELS } from '../../settings/reasoning-effort';

export function ReasoningEffortField({ form, onChange }: {
  form: TryloSettings;
  onChange: (value: TryloSettings['reasoningEffort']) => void;
}): JSX.Element {
  const enabled = form.cliRuntimeProtocol === 'trylo-v1';
  const choices = reasoningChoices(form.apiModel);
  const invalid = reasoningSelectionProblem(form);
  const unlisted = form.reasoningEffort !== undefined && !choices.levels.includes(form.reasoningEffort);
  return <div className="settings-modal__field">
    <label className="settings-modal__label" htmlFor="primary-reasoning-effort">思考强度</label>
    <select id="primary-reasoning-effort" className="settings-modal__input"
      value={form.reasoningEffort ?? ''} disabled={!enabled} aria-invalid={!!invalid}
      aria-describedby="primary-reasoning-hint primary-reasoning-scope"
      onChange={event => onChange(parseReasoningEffort(event.target.value))}>
      <option value="">跟随服务商（默认）</option>
      {unlisted && form.reasoningEffort && <option value={form.reasoningEffort} disabled>
        {REASONING_LABELS[form.reasoningEffort]}（当前模型不支持）
      </option>}
      {choices.levels.map(level => <option key={level} value={level}>{REASONING_LABELS[level]}（{level}）</option>)}
    </select>
    <span id="primary-reasoning-hint" className="settings-modal__hint">
      {enabled ? choices.hint : '仅新版 CLI 使用此设置；可在“行为与运行”中切换。'}
    </span>
    <span id="primary-reasoning-scope" className="settings-modal__hint">
      {enabled ? '影响每次模型请求的推理投入，保存后从下一次请求生效。跟随服务商不代表低档。' : '已保存的档位会保留，传统 CLI 的行为不变。'}
    </span>
    {invalid && <span role="alert" className="settings-modal__hint">{invalid}</span>}
  </div>;
}
