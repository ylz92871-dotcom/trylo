/**
 * User Cognition Skill — Answer Resolution (Skill doc §13).
 *
 * Turns a free-text user answer into structured candidates with explicit
 * scope, and decides whether the answer is clear enough or needs one
 * scoping follow-up.
 *
 * Rules encoded here (deterministic — no LLM in the default inference
 * mode):
 *   §13.2 ambiguous ("看情况")          -> 'reask'   (not an answer at all)
 *   §13.3 over-broad ("以后都直接做")   -> 'confirm_scope' (needs a boundary)
 *   §13.4 multiple scopes               -> one candidate per scope
 */

import type { CognitionQuestion } from '../types';
import { CORE_PATH_MARKERS, ORDINARY_MARKERS } from './map';

/**
 * Canonical claim phrasing for a cognition answer. Moved here from
 * cognition.ts so the Answer Resolution skill owns it; cognition.ts
 * re-exports it so the old import path keeps working.
 */
export function claimFromCognitionAnswer(question: CognitionQuestion, text: string): string {
  const t = text.trim();
  if (/核心/.test(t) && (/直接/.test(t) || /计划|验证/.test(t))) {
    return '用户在普通低风险任务中倾向直接执行，核心路径仍要求计划和最终验证。';
  }
  if (question.dimension === 'verification_audit') {
    return `用户对审核/验证的边界回答：${t.slice(0, 200)}`;
  }
  if (question.dimension === 'security_data_integrity') {
    return `用户对安全与数据完整性底线的回答：${t.slice(0, 200)}`;
  }
  return `用户在 ${question.dimension} 维度给出带作用域的认知回答：${t.slice(0, 200)}`;
}

/** One Evidence-shaped answer fragment. */
export interface CandidateAnswer {
  readonly claim: string;
  readonly scope: {
    readonly scopeTags: readonly string[];
    readonly corePath?: boolean;
    readonly taskCategory?: string;
  };
}

export type AnswerFollowUp = 'none' | 'confirm_scope' | 'reask';

export interface AnswerResolution {
  readonly candidates: readonly CandidateAnswer[];
  readonly followUp: AnswerFollowUp;
  readonly reason?: 'ambiguous' | 'over_broad' | 'scoped' | 'multi_scope';
}

const AMBIGUOUS =
  /^(看情况|随便|都行|都可以|都可以吧|看吧|嗯|哦|好|行|可以|是的|对|不确定|我不知道|都差不多)$/i;
const OVER_BROAD =
  /^(都|全部|一律|永远|以后都|直接做|直接开始|不用问|少废话)/i;

function lower(text: string): string {
  return text.toLocaleLowerCase();
}

const TASKS: Readonly<Array<[RegExp, string]>> = [
  [/数据库迁移|迁移/, 'database_migration'],
  [/安全|权限|密钥|凭据|审计关键词/, 'security'],
  [/前端|ui|界面/, 'frontend'],
  [/校验|审核|验证|audit/, 'verification'],
  [/持久化|存储/, 'persistence'],
];

function detectTaskCategory(text: string): string | undefined {
  for (const [re, tag] of TASKS) {
    if (re.test(text)) return tag;
  }
  return undefined;
}

/**
 * The canonical claim for a dimension, threaded with whatever scope the
 * user named so it stays faithful to the answer (Skill doc §13.4: do not
 * collapse a scoped answer into one vague preference).
 */
function claimFor(question: CognitionQuestion, text: string): string {
  return claimFromCognitionAnswer(question, text);
}

/**
 * Resolve one answer into candidates + a follow-up decision.
 */
export function resolveAnswer(
  question: CognitionQuestion,
  text: string,
): AnswerResolution {
  const t = text.trim();
  if (!t) return { candidates: [], followUp: 'reask', reason: 'ambiguous' };
  if (AMBIGUOUS.test(t)) {
    return { candidates: [], followUp: 'reask', reason: 'ambiguous' };
  }

  const hasCore = CORE_PATH_MARKERS.some((m) => lower(t).includes(m));
  const hasOrdinary = ORDINARY_MARKERS.some((m) => lower(t).includes(m));
  const bracketsCore = /核心/.test(t);

  // §13.3: an over-broad answer with NO scope word at all -> ask boundary.
  if (!hasCore && !hasOrdinary && OVER_BROAD.test(t)) {
    return {
      candidates: [
        {
          claim: claimFor(question, t),
          scope: { scopeTags: [question.dimension] },
        },
      ],
      followUp: 'confirm_scope',
      reason: 'over_broad',
    };
  }

  // §13.4: a single answer that names both an ordinary scope and a core
  // path -> split into two candidates with distinct scope.
  if (hasCore && hasOrdinary) {
    const taskCategory = detectTaskCategory(t);
    const ordinaryTags = [question.dimension, 'ordinary_low_risk'];
    const coreTags = [question.dimension, 'core_path'];
    return {
      candidates: [
        {
          claim: `普通/低风险任务：${claimFor(question, t)}`,
          scope: { scopeTags: ordinaryTags, corePath: false, taskCategory },
        },
        {
          claim: `核心路径保留更严格处理：${claimFor(question, t)}`,
          scope: { scopeTags: coreTags, corePath: true, taskCategory },
        },
      ],
      followUp: 'none',
      reason: 'multi_scope',
    };
  }

  // A single clear scope.
  const corePath = hasCore || bracketsCore;
  const scopeTags = corePath
    ? [question.dimension, 'core_path']
    : [question.dimension, 'ordinary_low_risk'];
  return {
    candidates: [
      {
        claim: claimFor(question, t),
        scope: {
          scopeTags,
          corePath,
          taskCategory: detectTaskCategory(t) ? detectTaskCategory(t) : undefined,
        },
      },
    ],
    followUp: 'none',
    reason: 'scoped',
  };
}

/**
 * Compose the scoping follow-up prompt shown after an over-broad answer,
 * so the confirm turn can nail a boundary (Skill doc §13.3 / §11.5).
 */
export function scopeBoundaryPrompt(question: CognitionQuestion, lastAnswer?: string): string {
  const said = (lastAnswer?.trim() || question.scopeHint).slice(0, 48);
  return (
    `你刚才说「${said}」。我想再确认一个边界：如果这意味着对核心链路（数据库迁移 / 持久化 / 主进程）或账号路径也放松检查，` +
    '你仍然希望我按同一原则处理吗？核心路径我可以继续留严格基线。'
  );
}