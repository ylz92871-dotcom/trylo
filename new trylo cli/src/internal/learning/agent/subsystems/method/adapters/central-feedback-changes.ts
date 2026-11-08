import type { ContentDomainFeedbackChange } from "../../../../../integration/learning-content/sources/domain-feedback.js";
import type { BoardState } from "../../../../control/state.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
import { isMethodCardContent } from "../assets/archive.js";
import { isCentralResearchMethodOrigin } from "../domain/research-origin.js";
import { canonicalObservations } from "../domain/inference-observations.js";
import { scopePredicateKey } from "../domain/scope-learning.js";
import { isRecord } from "../domain/experience-facts.js";
import { methodFocusedTarget } from "./central-source.js";
import { METHOD_RESEARCH_ALGORITHM, isMethodResearchFinding, methodResearchGrantId, methodResearchIssueId } from "./central-research-records.js";
import { identity } from "../../../../../validation/json-shape.js";

type Target = { readonly versionId: string; readonly scopeId: string; readonly issueId: string };

type FeedbackIndex = { readonly sequence: number; readonly changes: readonly ContentDomainFeedbackChange[];
  readonly byIssue: ReadonlyMap<string, readonly ContentDomainFeedbackChange[]> };

const indexes = new WeakMap<BoardState, Map<string, FeedbackIndex>>();
const NO_CHANGES: readonly ContentDomainFeedbackChange[] = Object.freeze([]);

/** One loaded native prefix, indexed once. A research card/review is not
 * delivery: only original fieldings and later use/assessment facts are emitted. */
export function projectMethodCentralFeedbackChanges(board: BoardState, input: { readonly scope: string }): readonly ContentDomainFeedbackChange[] {
  return feedbackIndex(board, input.scope).changes;
}

/** The body verifier shares the aggregate owner's immutable projection, without
 * rescanning or mapping every other issue's catalog for each exact body read. */
export function methodCentralFeedbackChangesForIssue(board: BoardState,
  input: { readonly scope: string; readonly issueId: string }): readonly ContentDomainFeedbackChange[] {
  return feedbackIndex(board, input.scope).byIssue.get(input.issueId) ?? NO_CHANGES;
}

function feedbackIndex(board: BoardState, scope: string): FeedbackIndex {
  let scopes = indexes.get(board);
  if (scopes === undefined) {
    scopes = new Map();
    indexes.set(board, scopes);
  }

  const cached = scopes.get(scope);
  if (cached?.sequence === board.sequence) return cached;

  // These are new navigation rows, not native Board records. Freeze the public
  // rows so one reader cannot mutate a later reader's canonical ownership guard.
  const changes = Object.freeze(buildMethodCentralFeedbackChanges(board, { scope }).map(row =>
    Object.freeze({ ...row, sourceRefs: Object.freeze([...row.sourceRefs]) })));
  const grouped = new Map<string, ContentDomainFeedbackChange[]>();

  for (const row of changes) {
    let rows = grouped.get(row.issueId);
    if (rows === undefined) {
      rows = [];
      grouped.set(row.issueId, rows);
    }
    rows.push(row);
  }

  const byIssue = new Map([...grouped].map(([issueId, rows]) => [issueId, Object.freeze(rows)] as const));
  const index = { sequence: board.sequence, changes, byIssue };

  scopes.set(scope, index);
  return index;
}

function buildMethodCentralFeedbackChanges(board: BoardState, input: { readonly scope: string }): readonly ContentDomainFeedbackChange[] {
  const issues = (board.learningIssues ?? []).filter(issue => issue.scope === input.scope && learningIssueOwner(issue) === "method");
  const proposals = new Map(board.proposals.map(row => [row.proposalId, row]));
  const cards = new Map(board.assets.flatMap(asset => {
    const proposal = asset.createdFromProposalId === undefined ? undefined : proposals.get(asset.createdFromProposalId);
    return asset.kind === "prompt_patch" && proposal?.domain === "prompt" && proposal.scope === asset.scope && isMethodCardContent(asset.content)
      ? [[asset.versionId, { asset, card: asset.content }] as const] : [];
  }));
  const targets = new Map<string, Map<string, Set<string>>>(), queue: Target[] = [];
  const add = (target: Target) => {
    let scopes = targets.get(target.versionId);
    if (scopes === undefined) {
      scopes = new Map();
      targets.set(target.versionId, scopes);
    }
    let owners = scopes.get(target.scopeId);
    if (owners === undefined) {
      owners = new Set();
      scopes.set(target.scopeId, owners);
    }
    if (!owners.has(target.issueId)) {
      owners.add(target.issueId);
      queue.push(target);
    }
  };
  const requested = new Map<string, string[]>();

  for (const issue of issues) {
    const legacy = methodFocusedTarget(issue);
    if (legacy !== undefined && cards.has(legacy.versionId)) {
      add({ ...legacy, issueId: issue.issueId });
      continue;
    }

    const source = issue.reports[0]?.source;
    if (source === undefined || !("kind" in source) || source.kind !== "research_request" || source.domain !== "prompt"
      || issue.issueId !== methodResearchIssueId(source.requestRef) || !issue.reports.every(row => "kind" in row.source
        && row.source.kind === "research_request" && row.source.domain === "prompt" && row.source.requestRef === source.requestRef
        && row.source.intentRef === source.intentRef)) continue;

    requested.set(source.requestRef, [...requested.get(source.requestRef) ?? [], issue.issueId]);
  }

  const researchGrants = new Map([...requested.keys()].map(ref => [methodResearchGrantId(ref), methodResearchIssueId(ref)]));
  const reservations = new Map<string, Set<string>>();

  for (const grant of board.centralLearningGrants ?? []) if (grant.scope === input.scope && grant.domain === "prompt"
    && researchGrants.get(grant.grantId) === grant.issueId) {
    let ids = reservations.get(grant.grantId);
    if (ids === undefined) {
      ids = new Set();
      reservations.set(grant.grantId, ids);
    }
    for (const item of grant.reservations) if (item.state === "settled") ids.add(item.reservationId);
  }

  type CardEntry = (typeof cards extends Map<string, infer V> ? V : never);
  const origins = new Map<string, CardEntry[]>();

  for (const value of cards.values()) {
    const origin = value.card.lineage.createdFrom;
    if (isCentralResearchMethodOrigin(origin) && requested.has(origin.requestRef)) origins.set(origin.checkpointRef, [...origins.get(origin.checkpointRef) ?? [], value]);
  }

  const scopes = new Map((board.methodExperienceFacts ?? []).flatMap(fact => fact.kind === "scope" && fact.hypothesis.scopeId === "research-source" ? [[fact.versionId, fact] as const] : []));

  for (const fact of board.rewardV2Facts ?? []) {
    const candidates = origins.get(fact.id);
    if (candidates === undefined || fact.scope !== input.scope || fact.algorithmVersion !== METHOD_RESEARCH_ALGORITHM || fact.kind !== "projection") continue;

    let step: unknown;

    try { step = JSON.parse(fact.payloadJson); }
    catch { continue; } // Corrupt provenance cannot establish a native lineage; the body reader owns diagnostics.

    if (!isRecord(step) || step.type !== "method_research_step" || step.schemaVersion !== 1 || !identity(step.requestRef)
      || !identity(step.reservationId) || !isMethodResearchFinding(step.finding) || step.finding.kind !== "candidate" || step.finding.candidate === undefined) continue;

    for (const value of candidates) {
      const origin = value.card.lineage.createdFrom, registered = scopes.get(value.asset.versionId);
      if (!isCentralResearchMethodOrigin(origin) || origin.requestRef !== step.requestRef || origin.reservationId !== step.reservationId
        || value.card.hint !== step.finding.candidate.hint || registered?.hypothesis.scopeId !== "research-source"
        || scopePredicateKey(registered.hypothesis.predicate) !== scopePredicateKey(step.finding.candidate.scope.predicate)
        || !reservations.get(methodResearchGrantId(origin.requestRef))?.has(origin.reservationId)) continue;
      for (const issueId of requested.get(origin.requestRef) ?? []) add({ versionId: value.asset.versionId, scopeId: registered.hypothesis.scopeId, issueId });
    }
  }

  const children = new Map<string, string[]>();

  for (const { asset, card } of cards.values()) if (asset.parentVersionId !== undefined && card.lineage.parentVersionId === asset.parentVersionId) {
    children.set(asset.parentVersionId, [...children.get(asset.parentVersionId) ?? [], asset.versionId]);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]!;
    for (const versionId of children.get(parent.versionId) ?? []) add({ ...parent, versionId });
  }

  const compilations = new Map((board.methodExperienceFacts ?? []).flatMap(fact => fact.kind === "review" ? [[fact.factId, fact] as const] : []));
  const owners = (versionId: string, scopeId: string, compilationId?: string) => {
    const compilation = compilationId === undefined ? undefined : compilations.get(compilationId);
    return compilationId !== undefined && (compilation?.versionId !== versionId || compilation.scopeId !== scopeId)
      ? undefined : targets.get(versionId)?.get(scopeId);
  };
  const changes: ContentDomainFeedbackChange[] = [];
  const emit = (issueIds: Iterable<string> | undefined, kind: ContentDomainFeedbackChange["kind"], factRef: string,
    unitRef: string, revisionRef: string, sourceRefs: readonly string[]) => {
    for (const issueId of issueIds ?? []) changes.push({ domain: "prompt", issueId, kind, factRef, unitRef, revisionRef, sourceRefs: [...new Set(sourceRefs)] });
  };
  const fieldings = new Map(board.fieldings.map(row => [row.exposureId, row]));

  for (const row of board.fieldings) if (cards.get(row.versionId)?.asset.createdFromProposalId === row.proposalId) {
    emit(owners(row.versionId, row.scope, row.binding?.compilationId), "delivery", row.exposureId, row.exposureId, row.exposureId, [row.versionId, row.exposureId]);
  }

  for (const fact of board.methodExperienceFacts ?? []) {
    if (fact.kind === "decision") emit(owners(fact.versionId, fact.decision.scopeId, fact.decision.compilationId),
      fact.decision.action === "adopt" ? "adoption" : "correction", fact.factId, fact.factId, fact.factId, [fact.versionId, fact.factId]);
    // Associated tool execution does not establish that a method was followed.
    else if (["restriction", "scope_retired", "compilation_exit", "exit"].includes(fact.kind)) {
      const scopeId = "scopeId" in fact ? fact.scopeId : undefined;
      const issueIds = scopeId === undefined ? new Set([...targets.get(fact.versionId)?.values() ?? []].flatMap(value => [...value])) : owners(fact.versionId, scopeId);
      emit(issueIds, "correction", fact.factId, "compilationId" in fact ? fact.compilationId : fact.versionId, fact.factId, [fact.versionId, fact.factId]);
    }
  }

  const writers = new Map(board.feedbacks.flatMap(row => row.observation === undefined ? [] : [[row.observation, new Set<string>()] as const]));

  for (const row of board.feedbacks) if (row.observation !== undefined && row.exposureId !== undefined) writers.get(row.observation)?.add(row.exposureId);

  for (const observation of canonicalObservations([...writers.keys()])) {
    const exposureIds = writers.get(observation), exposureId = exposureIds?.size === 1 ? [...exposureIds][0] : undefined;
    const delivered = exposureId === undefined ? undefined : fieldings.get(exposureId);
    if (exposureId === undefined || delivered?.versionId !== observation.versionId || delivered.scope !== observation.scopeId) continue;
    emit(owners(observation.versionId, observation.scopeId, observation.compilationId), observation.revision === 0 ? "quality" : "correction",
      observation.observationId, exposureId, `${observation.observationId}:revision:${observation.revision}`,
      [observation.versionId, observation.observationId, exposureId]);
  }

  return changes;
}
