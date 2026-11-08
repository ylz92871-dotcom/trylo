import { canonicalCardJson, DEFAULT_METHOD_GRANT } from "../domain/contracts.js";
import { bounded } from "../domain/experience-facts.js";
import { effectivePredicate, projectMaturity, scopeEnabled, scopesOf, type ScopeFact, type MaturityProjection } from "../domain/experience-state.js";
import { matchesScope, scopePosteriorOf, unresolvedScopeConditions } from "../domain/scope-learning.js";
import { renderExperience } from "../domain/experience-render.js";
import { rankScopesForCue } from "../domain/scope-retrieval.js";
import { sourceNeedsDeliberateTrial } from "../domain/source-trial-policy.js";
import { compilationBlockFor, renderCompilationBlock } from "../domain/compilation-block.js";
import { MAX_SCOPE_CAPTION_CHARS, scopeCaption } from "../domain/scope-description.js";
import { adoptionWindowClosed } from "../domain/adoption-window.js";
import type { ExperienceContext, ExperienceConditionRequest, ExperienceSelection, ExperienceSourceTrial } from "../experience-port.js";
import { methodMessage, type MethodSlotDelivery } from "../port.js";
import type { ExperienceView } from "./experience-runtime.js";
import { methodOriginTaskId } from "../domain/research-origin.js";

/** Pure task-context selection and bounded presentation. Runtime bindings,
 * persistence and request delivery remain with experience-runtime. */
export const ADOPTION_INSTRUCTION = "\n[method adoption] 本机会尚未记录采用/偏离。业务工具执行前，先调用method_context(operation=adopt)，versionId与scopeId使用context返回的真实ID，reason写实际采用原因；不适用则deviate。完成实际执行后，回答末尾按本槽m引用报告helped true/false；未知或未采用不报告。";

export function selectedDelivery(source: ExperienceView, selected: readonly ExperienceSelection[], context: ExperienceContext,
  requestBoundarySequence?: number): MethodSlotDelivery {
  const available = selected.filter(item => !item.adoptionWindowClosed && !adoptionWindowClosed(source.facts,
    { versionId: item.versionId, taskId: context.taskId, ...(item.stable ? { compilationId: item.compilationId } : {}) }));
  const fielded = available.map((item, index) => ({ receipt: { ref: `m${index + 1}`, versionId: item.versionId,
    proposalId: source.variants.find(variant => variant.versionId === item.versionId)!.proposalId,
    nicheId: item.scopeId, binding: { context: { ...context, features: { ...context.features } },
      ...(requestBoundarySequence === undefined ? {} : { requestBoundarySequence }),
      ...(item.stable ? { compilationId: item.compilationId } : {}) } }, hint: item.compact }));
  const delivery = methodMessage({ fielded, intent: false, vocabulary: { known: [], pending: [] } });
  if (delivery === undefined) return { message: { role: "system", content: available.length < selected.length ?
    "[method context] 本父任务已结算业务但未预先采用，采用窗口已关闭。正常继续，不补adopt或方法帮助反馈；仍可记录deviate/block。" :
    "[method context] 无匹配经验；正常分析。新子任务或关键条件改变时，探索前先调用method_context更新情境。" }, receipts: [] };

  const contextKey = canonicalCardJson(context);
  const pending = available.some(item => !source.facts.some(fact => fact.kind === "decision" &&
    fact.versionId === item.versionId && fact.decision.scopeId === item.scopeId &&
    fact.decision.compilationId === (item.stable ? item.compilationId : undefined) && canonicalCardJson(fact.context) === contextKey));

  return pending ? { ...delivery, message: { role: "system", content: delivery.message.content + ADOPTION_INSTRUCTION } } : delivery;
}

export function hookInstructions(catalog: string): string {
  return "[method context hook] 开始任务、进入新子任务或关键执行条件改变时，先于探索调用method_context(operation=context)，" +
    "用situation、opportunityId及features表达业务情境。下列条件只在确实成立时填写其feature/value；缺失条件不匹配。" +
    "随后匹配稳定经验作为默认规划起点；采用前调用adopt，偏离调用deviate说明原因。经验阻塞时立即block并恢复正常分析，勿重复套用。" +
    "同一情境/机会的连续步骤沿用绑定，普通工具结果不要求重查。" +
    "sourceTrialRequired须显式trial；待辨范围可用trial:{versionId,scopeId}试用原方法，未知条件不试用，不为刷门槛造任务。" +
    "需要原方法/例外时expand。反馈只报实际帮助，未知不要猜。\n" + catalog;
}

export function contextCatalog(source: ExperienceView, toolNames?: readonly string[], cue = "", taskId?: string): string {
  const limit = DEFAULT_METHOD_GRANT.slotChars - hookInstructions("").length;
  const lines: string[] = [];
  let used = 0;
  const maturity = projectMaturity(source);
  const ranked = [...rankScopesForCue(source, usableScopes(source, toolNames), cue, maturity)];
  const learnedVersions = new Set(source.variants.filter(item => taskId !== undefined
    && methodOriginTaskId(item.card.lineage.createdFrom) === taskId).map(item => item.versionId));
  const learnedHere = (scope: ScopeFact) => learnedVersions.has(scope.versionId);

  ranked.sort((a, b) => Number(learnedHere(b)) - Number(learnedHere(a)) || (learnedHere(a) && learnedHere(b) ? b.sequence - a.sequence : 0));

  for (const scope of ranked.slice(0, 24)) {
    const mature = maturity(scope.hypothesis);
    // A stable index describes applicability, never re-injects its original method.
    const identity = { versionId: scope.versionId, scopeId: scope.hypothesis.scopeId,
      condition: scopeCaption(mature?.review.compact?.when ?? scope.description, MAX_SCOPE_CAPTION_CHARS),
      ...(sourceNeedsDeliberateTrial(source, scope.hypothesis) ? { sourceTrialRequired: true } : {}) };
    const complete = JSON.stringify({ ...identity, predicate: effectivePredicate(source, scope.hypothesis) });
    // Oversize predicates remain discoverable. context() will return their
    // exact missing facts; no partial predicate is shown as a complete scope.
    const line = complete.length + 1 <= limit ? complete : JSON.stringify({ ...identity, predicateDeferred: true });
    if (used + line.length + 1 > limit) continue;

    lines.push(line);
    used += line.length + 1;
  }

  return lines.join("\n");
}

export function selectExperiences(source: ExperienceView, context: ExperienceContext, disabled: ReadonlySet<string>, toolNames?: readonly string[],
  trial?: ExperienceSourceTrial): readonly ExperienceSelection[] {
  const overhead = methodMessage({ fielded: [{ receipt: { ref: "m1", versionId: "", proposalId: "", nicheId: "" }, hint: "" }],
    intent: false, vocabulary: { known: [], pending: [] } })!.message.content.length;
  const maxTextChars = DEFAULT_METHOD_GRANT.slotChars - overhead - ADOPTION_INSTRUCTION.length - 8;
  const maturity = projectMaturity(source);
  const scopes = usableScopes(source, toolNames).filter(scope => !disabled.has(scope.versionId) &&
    matchesScope(effectivePredicate(source, scope.hypothesis), context.features) &&
    (trial === undefined ? !sourceNeedsDeliberateTrial(source, scope.hypothesis) :
      trial.versionId === scope.versionId && trial.scopeId === scope.hypothesis.scopeId));
  const candidates = scopes.flatMap(scope => selectionForScope(source, scope, context, maturity, trial, maxTextChars) ?? []);
  // Posterior weights update online even when no review call is made. They rank
  // hypotheses for one method, never manufacture reliability across versions.
  const weights = new Map<string, number>();

  for (const versionId of new Set(scopes.map(item => item.versionId))) {
    const updated = scopePosteriorOf(scopesOf(source, versionId).map(item => item.hypothesis), source.observations);
    for (const item of updated.hypotheses) weights.set(item.hypothesisId, item.posteriorWeight);
  }

  candidates.sort((a, b) => Number(a.adoptionWindowClosed ?? false) - Number(b.adoptionWindowClosed ?? false) ||
    Number(b.stable) - Number(a.stable) ||
    (b.sourceVersionIds?.length ?? 1) - (a.sourceVersionIds?.length ?? 1) ||
    (weights.get(scopes.find(item => item.versionId === b.versionId && item.hypothesis.scopeId === b.scopeId)!.hypothesis.id) ?? 0) -
    (weights.get(scopes.find(item => item.versionId === a.versionId && item.hypothesis.scopeId === a.scopeId)!.hypothesis.id) ?? 0));
  // Charge the complete delivered message, including identity/header/feedback
  // instructions. The old card-only budget cannot hide an unbounded catalog.
  let chars = overhead + ADOPTION_INSTRUCTION.length;
  const seen = new Set<string>();

  return candidates.filter(item => {
    const sources = item.sourceVersionIds ?? [item.versionId];
    if (sources.some(id => seen.has(id)) || chars + item.compact.length + 8 > DEFAULT_METHOD_GRANT.slotChars ||
      seen.size >= 8 || !bounded(item.compact, 1600)) return false;
    for (const id of sources) seen.add(id);
    chars += item.compact.length + 8;
    return true;
  });
}

function selectionForScope(source: ExperienceView, scope: ScopeFact, context: ExperienceContext, maturity: MaturityProjection,
  trial: ExperienceSourceTrial | undefined, maxTextChars: number): ExperienceSelection | undefined {
  const variant = source.variants.find(item => item.versionId === scope.versionId);
  if (variant === undefined) return undefined;

  const mature = trial === undefined ? maturity(scope.hypothesis) : undefined;
  const compact = mature?.review.compact;
  const text = compact === undefined ? `[试用方法] ${variant.card.hint}` : renderExperience({ compact,
    ...(mature?.review.procedure === undefined ? {} : { procedure: mature.review.procedure }) });
  const reminder = mature === undefined ? "" : renderCompilationBlock(compilationBlockFor(source.facts,
    { versionId: scope.versionId, scopeId: scope.hypothesis.scopeId, compilationId: mature.factId }, context.features), maxTextChars - text.length);

  return { versionId: variant.versionId, scopeId: scope.hypothesis.scopeId,
    ...(adoptionWindowClosed(source.facts, { versionId: variant.versionId, taskId: context.taskId,
      ...(mature === undefined ? {} : { compilationId: mature.factId }) }) ? { adoptionWindowClosed: true } : {}),
    ...(mature?.review.procedure === undefined ? {} : { procedureStepIds: mature.review.procedure.steps.map(step => step.id) }),
    sourceVersionIds: mature?.review.sources ?? [variant.versionId],
    compilationId: mature?.factId ?? variant.versionId, compact: text + reminder, stable: compact !== undefined };
}

export function usableScopes(source: ExperienceView, toolNames?: readonly string[]): readonly ScopeFact[] {
  return scopesOf(source).filter(scope => scopeEnabled(source, scope.hypothesis) &&
    source.variants.some(item => item.versionId === scope.versionId && item.retention !== "evicted" && item.ledger.state !== "archived" &&
      (toolNames === undefined || (item.card.appliesWhen.tools ?? []).every(name => toolNames.includes(name)))));
}

export function contextConditions(source: ExperienceView, context: ExperienceContext, disabled: ReadonlySet<string>,
  toolNames?: readonly string[], trial?: ExperienceSourceTrial): readonly ExperienceConditionRequest[] {
  const candidates = usableScopes(source, toolNames).filter(scope => !disabled.has(scope.versionId) &&
    (trial === undefined ? !sourceNeedsDeliberateTrial(source, scope.hypothesis) :
      trial.versionId === scope.versionId && trial.scopeId === scope.hypothesis.scopeId));
  const maturity = projectMaturity(source);

  return rankScopesForCue(source, candidates, context.situation, maturity).flatMap(scope => {
    const missing = unresolvedScopeConditions(effectivePredicate(source, scope.hypothesis), context.features);
    if (missing.length === 0) return [];
    return [{ versionId: scope.versionId, scopeId: scope.hypothesis.scopeId,
      condition: scopeCaption(maturity(scope.hypothesis)?.review.compact?.when ?? scope.description, MAX_SCOPE_CAPTION_CHARS), missing }];
  }).slice(0, 4);
}
