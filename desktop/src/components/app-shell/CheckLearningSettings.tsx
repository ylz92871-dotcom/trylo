import { useId } from 'react';
import { MAX_CHECK_LEARNING_TOKENS, checkLearningBudgetProblem, type CheckLearningSettings as CheckSettings } from '../../settings/check-learning';

/** Editing these settings only changes the next run's learning allowance. */
export function CheckLearningSettings({ value, onChange }: {
  readonly value: CheckSettings;
  readonly onChange: (value: CheckSettings) => void;
}): JSX.Element {
  const fieldId = useId();
  const problem = checkLearningBudgetProblem(value.tokenBudget);
  return <fieldset className="settings-modal__group">
    <legend className="settings-modal__legend">检查学习</legend>
    <p className="settings-modal__desc">从任务结果、漏检、误报和你的纠正中改进检查方式，在后续适用任务中执行。默认关闭。</p>
    <label className="settings-modal__field settings-modal__field--inline">
      <input type="checkbox" checked={value.enabled} onChange={event => onChange({ ...value, enabled: event.target.checked })} />
      <span className="settings-modal__label">启用检查学习</span>
    </label>
    <label className="settings-modal__field" htmlFor={fieldId}>
      <span className="settings-modal__label">每轮检查学习额度（tokens）</span>
      <input id={fieldId} type="number" min={0} max={MAX_CHECK_LEARNING_TOKENS} step={1}
        className="settings-modal__input" disabled={!value.enabled}
        value={Number.isNaN(value.tokenBudget) ? '' : value.tokenBudget}
        aria-invalid={problem !== undefined} aria-describedby={`${fieldId}-hint${problem ? ` ${fieldId}-error` : ''}`}
        onChange={event => onChange({ ...value, tokenBudget: event.target.value === '' ? Number.NaN : Number(event.target.value) })} />
    </label>
    {problem && <p id={`${fieldId}-error`} role="alert" className="settings-modal__test-result settings-modal__test-result--err">{problem}</p>}
    <p id={`${fieldId}-hint`} className="settings-modal__hint">{!value.enabled ? '开启后可设置学习额度。'
      : value.tokenBudget === 0 ? '额度为 0：记录检查经历并使用已有检查，暂不生成新检查。'
        : '每轮学习使用当前模型，最多花费所设 token 额度；检查执行沿用当前任务权限。'}</p>
    <p className="settings-modal__hint">暂停采集或仅本会话时停用检查学习。检查发现会显示在任务记录中。</p>
  </fieldset>;
}
