import type { BoardState } from "../../../../control/state.js";
import type { CollaborationAnalysisWindowV2, CollaborationV2Fact } from "./v2-contracts.js";
import { isCollaborationPracticeV2 } from "./v2-parse.js";
import { collaborationEvidenceClosureV2 } from "./v2-evidence.js";
import { contentHashOf } from "../../../../control/hash.js";

export type WindowPickV2 = { readonly window: CollaborationAnalysisWindowV2; readonly through: number };

export type WindowBudgetV2 = { readonly maxInputTokens: number; readonly estimate: (window: CollaborationAnalysisWindowV2) => number };

/** Only a processed prefix advances the cursor. Feedback's action receipts and source versions are never shed to fit. */
export function analysisWindowV2(state: BoardState, scope: string, cursor: number, budget?: WindowBudgetV2): WindowPickV2 | { readonly needTokens: number } | undefined {
  const facts = (state.collaborationV2Facts ?? []).filter(f => f.scope === scope);
  const sequence = new Map(state.appliedCommands.map(c => [c.commandId, c.sequence]));
  const position = (f: CollaborationV2Fact): number => sequence.get(`collaboration-v2:${f.factId}`) ?? 0;
  let pending = facts.filter(f => position(f) > cursor && isLearningOpportunityV2(f, facts)).slice(0, 12);
  if (pending.length === 0) return undefined;

  for (;;) {
    const identity = { scope, through: Math.max(...pending.map(position)) };
    const pick = buildWindow(state, facts, pending, { ...identity, eventLimit: 64 });
    const mandatory = new Set(pick.window.receipts?.exposures.map(e => e.versionId) ?? []);
    let window = pick.window;

    while (budget !== undefined && budget.estimate(window) > budget.maxInputTokens
      && window.practices.some(p => !mandatory.has(p.versionId))) {
      const optional = window.practices.find(p => !mandatory.has(p.versionId));
      window = { ...window, practices: window.practices.filter(p => p.versionId !== optional?.versionId) };
    }

    // Shed optional event bodies before deferring a complete long team episode.
    // Required subjects/adoption events and every original episode/receipt remain intact.
    for (const eventLimit of [32, 16]) {
      if (budget === undefined || budget.estimate(window) <= budget.maxInputTokens) break;
      const reduced = buildWindow(state, facts, pending, { ...identity, eventLimit }).window;
      window = { ...reduced, practices: window.practices };
    }

    const referencesFit = window.events.length <= 64 && window.episodes.length <= 32 && window.outcomes.length <= 32
      && (window.receipts?.exposures.length ?? 0) <= 32 && (window.receipts?.adoptions.length ?? 0) <= 32;
    const estimated = budget?.estimate(window) ?? 0;
    if (referencesFit && (budget === undefined || (Number.isFinite(estimated) && estimated <= budget.maxInputTokens))) return { ...pick, window };

    if (pending.length === 1) return { needTokens: referencesFit && Number.isFinite(estimated) ? estimated + 1024 : Number.MAX_SAFE_INTEGER };

    pending = pending.slice(0, Math.max(1, Math.floor(pending.length / 2)));
  }
}

export function isLearningOpportunityV2(fact: CollaborationV2Fact, facts: readonly CollaborationV2Fact[] = []): boolean {
  if (fact.kind === "outcome") {
    const problem = (fact.metrics.reworkCount ?? 0) > 0 || (fact.metrics.waitMs ?? 0) >= 1000;
    const adopted = fact.adoptionIds.some(id => facts.some(f => f.kind === "adoption" && f.factId === id && f.scope === fact.scope));
    const linked = facts.some(f => f.kind === "episode" && fact.episodeIds.includes(f.factId)
      && (isLearningOpportunityV2(f, facts) || (f.context.memberId !== "parent" && (fact.source === "external_checker" || fact.source === "user"))));
    return problem || adopted || linked;
  }

  if (fact.kind === "episode") {
    const problem = (fact.metrics.reworkCount ?? 0) > 0 || (fact.metrics.waitMs ?? 0) >= 1000;

    if (fact.context.memberId !== "parent") return problem || fact.source !== "runtime" || fact.metrics.delivery !== "unverified";

    const linkedMember = facts.some(f => f.kind === "episode" && f.context.memberId !== "parent" && f.scope === fact.scope
      && f.context.teamRunId === fact.context.teamRunId && fact.evidenceRefs.includes(f.factId));
    const cooperation = facts.some(f => f.kind === "event" && f.source === "runtime" && f.scope === fact.scope
      && f.context.teamRunId === fact.context.teamRunId && fact.eventIds.includes(f.factId)
      && ["split_task", "assign_member", "schedule_review", "request_context", "share_reference", "synchronize", "wait_for_dependency", "replan"].includes(f.action));

    return problem || linkedMember || cooperation;
  }

  return fact.kind === "event" && (fact.source === "peer_report" || (fact.metrics.reworkCount ?? 0) > 0
    || (fact.metrics.waitMs ?? 0) >= 1000 || (fact.action === "request_context" && fact.evidenceRefs.length > 0));
}

function buildWindow(state: BoardState, facts: readonly CollaborationV2Fact[], pending: readonly CollaborationV2Fact[],
  identity: { readonly scope: string; readonly through: number; readonly eventLimit: number }): WindowPickV2 {
  const { scope, through, eventLimit } = identity;
  const selected = collaborationEvidenceClosureV2(facts, pending.map(f => f.factId));
  const exposures = selected.filter((f): f is Extract<CollaborationV2Fact, { kind: "exposure" }> => f.kind === "exposure");
  const adoptions = selected.filter((f): f is Extract<CollaborationV2Fact, { kind: "adoption" }> => f.kind === "adoption");
  const fullEvents = selected.filter((f): f is Extract<CollaborationV2Fact, { kind: "event" }> => f.kind === "event");
  const mandatoryEvents = new Set([...pending.filter(f => f.kind === "event").map(f => f.factId), ...adoptions.flatMap(a => a.eventIds)]);
  const eventIds = new Set(fullEvents.filter(e => mandatoryEvents.has(e.factId)).map(e => e.factId));
  const recent = fullEvents.slice().reverse();
  const relevantEvents = recent.filter(event => !["tool_result", "execution_usage"].includes(event.action));

  for (const event of [...relevantEvents, ...recent]) if (eventIds.size < eventLimit) eventIds.add(event.factId);

  const events = fullEvents.filter(e => eventIds.has(e.factId));
  const projection = events.length === fullEvents.length ? undefined : { omittedEventCount: fullEvents.length - events.length,
    fullEventSetHash: contentHashOf(fullEvents) };
  const mandatory = new Set(exposures.map(e => e.versionId));
  const dimensions = new Set(selected.filter(f => f.kind === "event").map(f => f.dimension));
  const latest = new Map<string, typeof state.assets[number]>();

  for (const asset of state.assets) if (asset.scope === scope && isCollaborationPracticeV2(asset.content)) latest.set(asset.content.familyId, asset);

  const relevant = [...latest.values()].reverse().filter(a => isCollaborationPracticeV2(a.content)
    && a.content.actions.some(action => dimensions.has(action.dimension))).slice(0, 2);
  const keep = new Set(mandatory);

  for (const asset of relevant) if (keep.size < 32) keep.add(asset.versionId);

  const practices = state.assets.filter(a => keep.has(a.versionId)).flatMap(a => isCollaborationPracticeV2(a.content) ? [{ versionId: a.versionId, practice: a.content }] : []);

  return { through, window: { schemaVersion: 2, scope, boardSequence: through,
    events, ...(projection === undefined ? {} : { projection }),
    episodes: selected.filter((f): f is Extract<CollaborationV2Fact, { kind: "episode" }> => f.kind === "episode"),
    outcomes: selected.filter((f): f is Extract<CollaborationV2Fact, { kind: "outcome" }> => f.kind === "outcome"),
    receipts: {
      exposures,
      adoptions,
    }, practices } };
}
