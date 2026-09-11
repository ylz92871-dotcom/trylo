/**
 * Work-surface preference language. Code extraction historically only
 * recognised review/plan/runtime vocabulary, so typical Work utterances
 * ("PPT 太花了", "你自己点", "只要结论") produced empty Evidence.
 */
import type { PolicyDimension } from './types';

export const WORK_ARTIFACT_RE =
  /ppt|pptx|幻灯|报告|周报|月报|文档|docx|xlsx|表格|成品|排版|版式|交付|重做|格式不对|结构先|先看结构/i;
export const WORK_UX_RE =
  /太花|太乱|不好看|不好看|太丑|简洁|咨询风|版式|观感|接受不了|不像正式|花哨/i;
export const WORK_TOOL_RE =
  /电脑|桌面|屏幕|自己点|你点|浏览器|填表|自己操作|键鼠|截屏|点确定/i;
export const WORK_PROCESS_RE =
  /只要结论|不要过程|别列步骤|过程别写|别写那么长|少说过程|不要长篇|别解释那么多|不要先列/i;
export const WORK_AUTONOMY_RE =
  /自己点|自己操作|别每步问|你直接|不用问我|先给我看|关键再问|账号.*先问|涉及账号/i;
export const WORK_REDO_RE = /重做|重来|不行.*再|格式不对|这个不对|再出一版|推翻/i;
/** PR-5: praise ("这个很好", "PPT不错") + template ("做成模板") */
export const WORK_PRAISE_RE = /很好|不错|好.*交付|很喜欢|点赞|这个好|这个可以|优质|满意|漂亮|效果好/i;
export const WORK_TEMPLATE_RE = /做成模板|搞成模板|当模板|存成模板|模板化/i;

export function isWorkPreferenceText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (WORK_UX_RE.test(t) || WORK_PROCESS_RE.test(t) || WORK_AUTONOMY_RE.test(t) || WORK_REDO_RE.test(t)) {
    return true;
  }
  if (WORK_ARTIFACT_RE.test(t) && /先出|先看结构|先改|正式|太花|干净|重做|只要结论/.test(t)) {
    return true;
  }
  if (WORK_TOOL_RE.test(t) && /自己点|自己做|先问|别每步|不用问/.test(t)) {
    return true;
  }
  return false;
}

/** PR-5: True when the composer text is a template-only request that should
 *  NOT send a Work run or open a trace. "帮我做一份周报" is a normal Work
 *  request (= 0 praise); "做成模板" or "把这份做成模板" alone is template-only. */
export function isTemplateOnlyComposerText(text: string): boolean {
  const t = text.trim();
  return WORK_TEMPLATE_RE.test(t) && !WORK_ARTIFACT_RE.test(t) && t.length < 20;
}

export function dimensionForWorkText(text: string): PolicyDimension | null {
  if (!isWorkPreferenceText(text)) return null;
  if (WORK_TOOL_RE.test(text) && WORK_AUTONOMY_RE.test(text)) return 'tool_workflow';
  if (WORK_TOOL_RE.test(text)) return 'tool_workflow';
  if (WORK_UX_RE.test(text) || WORK_REDO_RE.test(text)) return 'product_ux_acceptance';
  if (WORK_PROCESS_RE.test(text)) return 'reporting_information_density';
  if (WORK_AUTONOMY_RE.test(text)) return 'agent_autonomy';
  if (WORK_ARTIFACT_RE.test(text)) return 'work_artifact_workflow';
  return 'work_artifact_workflow';
}

export function claimForWorkText(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  // PR-5: praise before redo — "很好，但是重做" → redo, not praise.
  if (WORK_REDO_RE.test(t) && (WORK_UX_RE.test(t) || WORK_ARTIFACT_RE.test(t))) {
    return '用户对当前产物不满意并要求重做，成品观感或结构未达到接受标准。';
  }
  if (WORK_PRAISE_RE.test(t) && !WORK_REDO_RE.test(t)) {
    return '用户对当前交付件表示满意或称赞，该产物达到可接受标准。';
  }
  if (WORK_TEMPLATE_RE.test(t)) {
    return '用户要求将当前交付件做成模板，倾向于保留可复用的工作结果。';
  }
  if (WORK_UX_RE.test(t)) {
    return '用户对交付件观感要求偏克制、干净，不接受花哨或非正式的版式。';
  }
  if (WORK_PROCESS_RE.test(t) && WORK_ARTIFACT_RE.test(t)) {
    return '用户在 Work 交付里只要结论、结构和产物，不需要过程叙述。';
  }
  if (WORK_PROCESS_RE.test(t)) {
    return '用户对低信息密度的过程性叙述接受度较低，希望先看到结论和产物。';
  }
  if (/账号|支付|密码|登录/.test(t) && (/先问|先给我看|不要自己/.test(t))) {
    return '涉及账号、支付或登录时，用户要求先确认再操作电脑或浏览器。';
  }
  if (WORK_AUTONOMY_RE.test(t) && WORK_TOOL_RE.test(t)) {
    return '低风险电脑或浏览器操作上，用户倾向 Agent 自己做完，不要逐步请示。';
  }
  if (/先给我看结构|先看大纲|先看目录|先看结构/.test(t)) {
    return '对外方案、合同或正式文档，用户要求先看结构再往下做。';
  }
  if (WORK_ARTIFACT_RE.test(t) && /快|直接|先出一版/.test(t)) {
    return '普通报告或幻灯片，用户倾向先出一版再改，而不是先长篇规划。';
  }
  if (WORK_ARTIFACT_RE.test(t)) {
    return `用户对 Work 产物提出了协作偏好：${t.slice(0, 180)}`;
  }
  if (WORK_TOOL_RE.test(t)) {
    return `用户对电脑或浏览器操作提出了协作偏好：${t.slice(0, 180)}`;
  }
  return null;
}

export interface StructuredWorkEvent {
  readonly kind?: string;
  readonly fileName?: string;
  readonly packageId?: string;
  readonly origin?: string;
  readonly leaseKind?: string;
}

export function claimForStructuredWork(event: StructuredWorkEvent, text: string): string | null {
  switch (event.kind) {
    case 'artifact_promote':
      return event.fileName
        ? `用户把产物「${event.fileName}」提升为正式交付件，倾向保留可复用的工作结果。`
        : '用户把当前产物提升为正式交付件。';
    case 'artifact_redo':
      return '用户要求重做当前产物，说明成品尚未达到接受标准。';
    case 'artifact_praise':
      return event.fileName
        ? `用户称赞了产物「${event.fileName}」，该产物达到可接受标准。`
        : '用户称赞了当前交付件，该产物达到可接受标准。';
    case 'template_request':
      return '用户要求将当前交付件做成模板，适用于重复性场景。';
    case 'lease_grant_screen':
      return '用户授权了桌面屏幕访问。低风险电脑操作可以继续，但不等于放开账号或支付路径。';
    case 'lease_grant_click':
      return '用户授权了桌面键鼠操作。低风险点击可以自己做。';
    case 'lease_grant_browser':
      return event.origin
        ? `用户授权了浏览器访问 ${event.origin}。授权范围内可以继续，超出范围仍应先问。`
        : '用户授权了当前站点的浏览器操作。';
    case 'work_stop':
      return '用户中途停止了 Work 任务，当前交付路径被打断。';
    default:
      return text.trim() ? null : null;
  }
}
