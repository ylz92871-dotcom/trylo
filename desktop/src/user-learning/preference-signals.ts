/**
 * Trylo — 主动提问触发信号抽取器（强信号驱动）。
 * TRYLO-COGNITION-PROACTIVE-REDESIGN-2026-09-06 §2.1。
 *
 * 职责：从本轮用户文本（及 Work 面事件）抽取「显式偏好强信号」，
 * 纯函数、无 store 依赖。只有显式偏好强信号才允许 in-task 主动提问；
 * 纯 gap（"还不懂"）不再触发。信号文法与维度词表**冻结于本文件**，
 * 实现不得私自扩词（词表变更须走文档附录修订）。
 */

import type { PolicyDimension, ProductSurface, UserSignalKind } from './types';
import {
  WORK_ARTIFACT_RE,
  WORK_UX_RE,
  WORK_TOOL_RE,
  WORK_REDO_RE,
} from './work-signals';

export interface PreferenceSignal {
  readonly dimension: PolicyDimension;
  readonly kind: Extract<UserSignalKind, 'correction' | 'collaboration_preference' | 'task_override'>;
  readonly strength: 'strong' | 'weak';
  readonly matchedText: string; // 诊断用，进 learning-diagnostics
}

// ── 维度归属词表（§2.1 SIGnal_DIMENSION_TABLE）─────────────────────
// 由 cognition-insert.ts 的相关性词表升级而来，按维度归类。
export const SIGNAL_DIMENSION_TABLE: Readonly<Record<PolicyDimension, readonly string[]>> = {
  agent_autonomy: ['问我', '先问', '打断', '自主'],
  planning_direct_execution: ['计划', '方案', '先规划', '先计划', '规划'],
  engineering_depth: [],
  architecture_refactor: ['抽象', '重构', '抽层'],
  verification_audit: ['审核', 'review', '验证', 'test', '检验', '检查'],
  git_change_management: ['提交', 'commit', 'checkpoint', '留恢复点'],
  cost_time_quality: ['成本', '快一点', '省时', '图快'],
  interaction_interruption: ['打断', '问我', '先问'],
  reporting_information_density: ['汇报', '过程', '更新', '叙述', '细节', '说过程'],
  tool_workflow: ['电脑', '桌面', '屏幕', '浏览器', '自己点', '键鼠', '截屏', '点确定'],
  product_ux_acceptance: ['简洁', '正式', '好看', '观感', '干净', '花哨'],
  domain_capability_feedback_reliability: [],
  engineering_language_semantics: ['工程用语', '术语'],
  security_data_integrity: ['备份', '权限', '密钥', '安全', '密码', '账号', '登录'],
  work_artifact_workflow: ['ppt', 'pptx', '幻灯', '报告', '周报', '月报', '文档', 'docx', 'xlsx', '表格', '成品', '排版', '版式', '交付', '先出一版', '先看结构', '正式', '对外'],
};

// ── 信号文法（四类，词表冻结，§2.1）─────────────────────────────
// kind 映射：纠正 → correction；声明 / 回顾褒贬 → collaboration_preference；
// 授权覆写 → task_override。
const CORRECTION_RE = /不对|别这样|不要|我说过|记住|以后都|改成|又错了/i;
const DECLARATION_RE = /我习惯|我偏好|我喜欢|我要求|必须|一定|永远|每次|都别/i;
const RETROSPECTIVE_RE = /(?:上次|上回|之前)[^。！？!?]{0,8}(?:很好|不错|就要这样|太烦|不行|受不了)/i;
const OVERRIDE_RE = /不用问|直接做|别自动|先问我|每步都问|自己做完再汇报/i;

type SignalClass = { readonly kind: PreferenceSignal['kind']; readonly re: RegExp };
const SIGNAL_CLASSES: readonly SignalClass[] = [
  { kind: 'correction', re: CORRECTION_RE },
  { kind: 'collaboration_preference', re: DECLARATION_RE },
  { kind: 'collaboration_preference', re: RETROSPECTIVE_RE },
  { kind: 'task_override', re: OVERRIDE_RE },
];

/** 信号词本身即携带维度语义（§2.1 strength 规则）：命中即强信号。 */
const SELF_CARRYING: readonly { readonly dimension: PolicyDimension; readonly re: RegExp }[] = [
  { dimension: 'agent_autonomy', re: /别自动做|别自动|不要自动|自主/i },
  { dimension: 'agent_autonomy', re: /先问我|每步都问/i },
  { dimension: 'work_artifact_workflow', re: /先出一版|先看结构|先看大纲|正式材料|对外方案|先看目录/i },
  { dimension: 'planning_direct_execution', re: /先规划|先计划|先出方案/i },
];

/** 隐含的 "我自己定" 类授权词 → 归到 report 协作偏好维度。 */
const GREETINGS_RE = /^(你好|您好|hi|hello|hey|hola|早上好)$/i;

function sentences(text: string): readonly string[] {
  return text.split(/[。！？!?；;\n]/).map((s) => s.trim()).filter(Boolean);
}

function dimensionWordsPresent(sentence: string, product: ProductSurface): readonly PolicyDimension[] {
  const dims: PolicyDimension[] = [];
  for (const dimension of Object.keys(SIGNAL_DIMENSION_TABLE) as PolicyDimension[]) {
    const words = SIGNAL_DIMENSION_TABLE[dimension];
    if (dimension === 'work_artifact_workflow' || dimension === 'tool_workflow' || dimension === 'product_ux_acceptance') {
      if (product !== 'work') continue;
    }
    if (words.length > 0 && words.some((w) => sentence.includes(w))) dims.push(dimension);
  }
  // Work 维度额外复用 work-signals 正则（覆盖式匹配）。
  if (product === 'work') {
    if ([WORK_ARTIFACT_RE, WORK_UX_RE, WORK_TOOL_RE, WORK_REDO_RE].some((re) => re.test(sentence))) {
      const mapped = dimensionForWorkWords(sentence);
      if (mapped && !dims.includes(mapped)) dims.push(mapped);
    }
  }
  return dims;
}

function dimensionForWorkWords(text: string): PolicyDimension | null {
  if (WORK_TOOL_RE.test(text) && /自|直接/.test(text)) return 'tool_workflow';
  if (WORK_TOOL_RE.test(text)) return 'tool_workflow';
  if (WORK_UX_RE.test(text) || WORK_REDO_RE.test(text)) return 'product_ux_acceptance';
  if (WORK_ARTIFACT_RE.test(text)) return 'work_artifact_workflow';
  return 'work_artifact_workflow';
}

/**
 * 从本轮用户文本抽取显式偏好强信号。
 * - strong = 信号词与维度词**同句**命中；或信号词自带维度语义（SELF_CARRYING）。
 * - 仅命中其一（weak）不触发。
 * - 问候语 / 纯任务陈述（无信号词）= 无信号。
 */
export function extractPreferenceSignals(
  prompt: string,
  product: ProductSurface,
): readonly PreferenceSignal[] {
  const t = prompt.trim();
  if (!t || GREETINGS_RE.test(t)) return [];
  const found: PreferenceSignal[] = [];
  const seen = new Set<PolicyDimension>();

  const push = (sig: PreferenceSignal): void => {
    if (seen.has(sig.dimension)) return;
    seen.add(sig.dimension);
    found.push(sig);
  };

  // 1) 信号词自带维度语义 → 强信号。
  for (const { dimension, re } of SELF_CARRYING) {
    const m = re.exec(t);
    if (m) {
      push({
        dimension,
        kind: /先出方案|先规划|先计划/.test(m[0]) ? 'collaboration_preference' : 'task_override',
        strength: 'strong',
        matchedText: m[0],
      });
    }
  }

  // 2) 信号词 + 维度词同句 → 强信号。
  for (const sentence of sentences(t)) {
    const dims = dimensionWordsPresent(sentence, product);
    if (dims.length === 0) continue;
    for (const cls of SIGNAL_CLASSES) {
      const m = cls.re.exec(sentence);
      if (!m) continue;
      for (const dimension of dims) {
        push({
          dimension,
          kind: cls.kind,
          strength: 'strong',
          matchedText: m[0],
        });
      }
    }
  }

  // 去重后按维度返回（一个维度至多一个强信号）。
  return found;
}