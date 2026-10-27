import { contextModelKey, type ContextModelIdentity } from './context-window';
import { parseReasoningEffort, REASONING_EFFORTS, REASONING_LABELS, type ReasoningEffort } from './reasoning-effort';

export type ModelReasoningPreferences = Readonly<Record<string, ReasoningEffort | 'default'>>;

/** Free-pool choices are independent of the user's private connection. */
export function modelReasoningEffort(settings: ContextModelIdentity & {
  readonly reasoningEffort?: ReasoningEffort;
  readonly modelReasoningPreferences?: ModelReasoningPreferences;
}): ReasoningEffort | undefined {
  if (!settings.poolModel?.trim()) return settings.reasoningEffort;
  return parseReasoningEffort(settings.modelReasoningPreferences?.[contextModelKey(settings)]);
}

export function parseModelReasoningPreferences(value: unknown): ModelReasoningPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries: [string, ReasoningEffort | 'default'][] = [];
  for (const [key, raw] of Object.entries(value)) {
    const effort = raw === 'default' ? 'default' : parseReasoningEffort(raw);
    if (effort !== undefined) entries.push([key, effort]);
  }
  return Object.fromEntries(entries);
}

export function amdReasoningLabel(model: string, effort: ReasoningEffort): string {
  return model === 'MiMo-V2.6-Flash' && effort === 'none' ? '最低投入' : REASONING_LABELS[effort];
}

/** Radeon Cloud endpoint contract, verified 2026-10-27. This intentionally
 * differs from direct vendor endpoints (notably GLM and Qwen).
 * https://amd-aim.github.io/radeon-cloud-docs/models/overview/
 */
export function amdReasoningChoices(model: string): { levels: readonly ReasoningEffort[]; hint: string } {
  switch (model) {
    case 'DeepSeek-V4.1-Flash':
    case 'DeepSeek-V4-Flash':
      return { levels: REASONING_EFFORTS, hint: '默认不启用思考；可按任务调整推理投入。' };
    case 'MiMo-V2.6-Flash':
      return { levels: REASONING_EFFORTS, hint: '默认启用思考；none 也不保证关闭思考。' };
    case 'Qwen3.8-Flash-Next':
      return { levels: ['none', 'low', 'medium', 'xhigh'], hint: '默认更深入（xhigh）；轻量通常更快。' };
    case 'Qwen3.8-27B':
      return { levels: ['low', 'medium', 'xhigh'], hint: '默认更深入（xhigh）；可调低推理投入。' };
    case 'GLM-5.3-Flash':
      return { levels: ['low', 'medium', 'high'], hint: '默认启用思考；更高强度通常需要更多时间。' };
    case 'MiniCPM5-2B':
      return { levels: [], hint: '该模型直接回答，不提供思考强度调节。' };
    case 'MiniCPM-V-4.7-1B':
    case 'MiniCPM-V-4.7-35B-A3B':
    case 'Gemma-4-31B-IT':
      return { levels: [], hint: '该模型使用独立思考开关，当前免费池不提供强度档位。' };
    default:
      return { levels: [], hint: '尚未确认该免费模型的思考档位，先跟随服务商。' };
  }
}
