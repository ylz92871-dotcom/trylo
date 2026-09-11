/**
 * User Cognition Skill — Question Strategy (Skill doc §11 / §5).
 *
 * Frames a question: prefer the real current task when present, otherwise
 * a concrete typical engineering scenario; always try to form a scope;
 * prefer trade-off / contrast questions; hunt for boundaries. Deterministic
 * for P0 — candidates surface through the pre-authored prompt + scopeHint.
 */

import type { CognitionQuestion } from '../types';

/**
 * Frame a question for display. When a real task context is available we
 * open with it (§11.1); otherwise we lean on the question's own scenario
 * (§11.2). scopeHint is kept visible as the boundary to explore (§11.3).
 */
export function frameQuestion(
  question: CognitionQuestion,
  currentTask?: string,
): string {
  const lead = currentTask && currentTask.trim()
    ? `结合当前任务（${currentTask.trim().slice(0, 80)}）：\n`
    : '';
  const boundary = question.scopeHint ? `\n\n（想确认的边界：${question.scopeHint}）` : '';
  return `${lead}${question.prompt}${boundary}`;
}

/**
 * Scope-boundary follow-up, used when a prior conclusion may not apply to
 * a brand-new engineering scope (§6.4 Scope Boundary).
 */
export function scopeBoundaryQuestion(
  conclusionStatement: string,
  newScope: string,
): string {
  return (
    `你之前在「${conclusionStatement}」上更倾向于一种做法。\n` +
    `这次第一次进入「${newScope}」，我不确定这个偏好是否仍然适用。\n` +
    '这里仍按同一原则处理吗？'
  );
}