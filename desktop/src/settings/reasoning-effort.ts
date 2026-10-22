/** UI choices describe known model contracts, not the backend behind an alias.
 * Unknown/custom endpoints remain selectable and must validate their own support.
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const REASONING_LABELS: Readonly<Record<ReasoningEffort, string>> = {
  none: '关闭', minimal: '极简', low: '轻量', medium: '标准', high: '深入', xhigh: '更深入', max: '最深',
};

export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? value as ReasoningEffort : undefined;
}

export function reasoningChoices(model: string): { levels: readonly ReasoningEffort[]; hint: string } {
  const id = model.trim().toLowerCase();
  if (/^glm-5[.-]3(?:$|-)/.test(id)) return {
    levels: ['low', 'high', 'max'], hint: 'GLM 5.3 / Flash 默认使用最深思考，支持轻量、深入和最深。',
  };
  if (/^glm-5[.-]2(?:$|-)/.test(id)) return {
    levels: ['high', 'max'], hint: 'GLM 5.2 默认使用最深思考，支持深入和最深。',
  };
  if (/^gpt-6(?:[.-]1)?-(?:astra|sol|luna)(?:$|-)/.test(id)) return {
    levels: /^(?:gpt-6-astra|gpt-6[.-]1-sol)(?:$|-)/.test(id)
      ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    hint: '此模型支持按档位调整推理投入；更高档位通常需要更多时间。',
  };
  return { levels: REASONING_EFFORTS,
    hint: '当前模型或别名的支持范围未确认，请按服务商说明选择；不支持的档位可能被拒绝。' };
}

export function reasoningSelectionProblem(input: { apiModel?: string; reasoningEffort?: ReasoningEffort; cliRuntimeProtocol?: string }): string | undefined {
  if (input.reasoningEffort === undefined || (input.cliRuntimeProtocol !== undefined && input.cliRuntimeProtocol !== 'trylo-v1')) return undefined;
  return reasoningChoices(input.apiModel ?? '').levels.includes(input.reasoningEffort) ? undefined
    : '当前模型不支持所选思考强度，请重新选择档位或跟随服务商。';
}
