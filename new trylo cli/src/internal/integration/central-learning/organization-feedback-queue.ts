import type { BoardState } from "../../learning/control/state.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { OrganizationFeedback, OrganizationProjection } from "../../learning/central/organization/contracts.js";
import { organizationFeedbackKey } from "../../learning/central/organization/retrieval.js";
import { projectOrganizationCosts } from "./organization-feedback-cost.js";
import { projectOrganizationNativeFeedbackChanges } from "./organization-feedback-changes.js";
import { projectOrganizationDomainFeedback } from "./organization-feedback-sources.js";
import { projectOrganizationExactFeedbackFrame } from "./organization-feedback-exact.js";
import { indexOrganizationDomainRows } from "./organization-feedback-domain.js";
import type { OrganizationDecisionRelationIndex } from "./organization-feedback-relations.js";
import { organizationFeedbackBackground, type OrganizationFeedbackRelation } from "./organization-feedback-views.js";

export interface OrganizationFeedbackSelection {
  readonly decisionRefs?: readonly string[]; readonly issueRefs?: readonly string[]; readonly sourceRefs?: readonly string[];
}

const unique = (refs: readonly string[]) => [...new Set(refs)];

/** Original native issue metadata is indexed once, independently of model query
 * truncation. Shared roots and same-issue membership remain background only. */
function issueReferences(board: BoardState, scope: string) {
  const refs = new Map<string, Set<string>>();
  const add = (ref: string | undefined, issueId: string) => {
    if (ref === undefined) return;
    const ids = refs.get(ref) ?? new Set();
    ids.add(issueId);
    refs.set(ref, ids);
  };
  const issues = (board.learningIssues ?? []).filter(issue => issue.scope === scope);

  for (const issue of issues) for (const ref of [issue.issueId, issue.grantId, issue.jobId]) add(ref, issue.issueId);

  const known = new Set(issues.map(issue => issue.issueId));

  for (const grant of board.centralLearningGrants ?? []) if (grant.scope === scope && known.has(grant.issueId)) {
    add(grant.grantId, grant.issueId);
    add(grant.jobId, grant.issueId);
  }

  return (values: readonly string[]) => unique(values.flatMap(ref => [...refs.get(ref) ?? []]));
}

/** Prepare a finite reconciliation queue, not a paged semantic agenda. Owners
 * read each original issue once; only actual source-unit relationships fan out. */
export function organizationFeedbackQueue(input: { readonly board: BoardState; readonly view: OrganizationProjection;
  readonly workspaceId: string; readonly selection: OrganizationFeedbackSelection; readonly relations: OrganizationDecisionRelationIndex;
  readonly secrets?: readonly string[];
  readonly project: typeof projectOrganizationDomainFeedback; readonly check: () => void }) {
  const { board, view, selection, relations } = input, issuesFor = issueReferences(board, view.scope);
  const money = new Set((board.centralLearningBudgets ?? []).flatMap(budget => [budget.budgetId,
    ...(budget.accounting ?? []).map(reservation => reservation.reservationId)]));
  const explicit = new Set(selection.decisionRefs ?? []), sources = new Set((selection.sourceRefs ?? []).filter(ref => !money.has(ref)));
  const requestedIssues = new Set(issuesFor([...(selection.issueRefs ?? []), ...sources]));
  const safeReferences = new Map(view.decisions.map(({ value }) => {
    const relation = relations.byDecision.get(value.decisionRef);
    return [value.decisionRef, unique([...value.sourceRefs, ...value.issueRefs, ...value.stageRefs,
      ...(relation?.produced_by ?? []), ...(relation?.selected_by ?? []), ...(relation?.related_background ?? [])])] as const;
  }));
  // Historical aggregated progress may navigate background; it cannot enter the
  // producer/selector index or assert ownership of a sibling artifact.
  const progressRefs = new Map<string, Set<string>>();

  for (const row of view.feedback) if (row.value.result.kind === "progress") {
    const refs = progressRefs.get(row.value.decisionRef) ?? new Set<string>();
    for (const ref of [...row.value.sourceRefs, ...row.value.result.resultRefs]) refs.add(ref);
    progressRefs.set(row.value.decisionRef, refs);
  }

  const backgroundRefs = new Map(view.decisions.map(({ value }) => [value.decisionRef,
    unique([...(safeReferences.get(value.decisionRef) ?? []), ...(progressRefs.get(value.decisionRef) ?? [])])] as const));
  const byIssue = new Map(view.decisions.map(row => [row.value.decisionRef, issuesFor(backgroundRefs.get(row.value.decisionRef) ?? [])]));
  const selected = view.decisions.filter(row => explicit.has(row.value.decisionRef)
    || (backgroundRefs.get(row.value.decisionRef) ?? []).some(ref => sources.has(ref))
    || (byIssue.get(row.value.decisionRef) ?? []).some(issue => requestedIssues.has(issue)));
  const issueIds = unique([...requestedIssues, ...selected.flatMap(row => byIssue.get(row.value.decisionRef) ?? [])]).sort();
  const relevant = view.decisions.filter(row => selected.includes(row) || (byIssue.get(row.value.decisionRef) ?? []).some(issue => issueIds.includes(issue)))
    .sort((a, b) => a.sequence - b.sequence);
  const entries = new Map<string, { readonly feedback: OrganizationFeedback; readonly relation: OrganizationFeedbackRelation }>();
  const priorUnits = new Map<string, typeof view.feedback>();
  const unitKey = (feedback: OrganizationFeedback) => JSON.stringify([feedback.unitRef, feedback.result.kind]);

  for (const row of view.feedback) {
    const key = unitKey(row.value);
    priorUnits.set(key, [...priorUnits.get(key) ?? [], row]);
  }

  const background: CentralRuntimeMaterial[] = [], sourceRefs: string[] = [];
  const changes = issueIds.length === 0 ? [] : projectOrganizationNativeFeedbackChanges(board, { scope: view.scope, workspaceId: input.workspaceId });

  for (const issueId of issueIds) {
    input.check();
    const decisions = relevant.filter(row => byIssue.get(row.value.decisionRef)?.includes(issueId));
    if (decisions.length === 0) continue;

    background.push(...organizationFeedbackBackground(issueId, decisions.map(row => row.value.decisionRef)));
    const nativeChanges = changes.filter(change => change.issueId === issueId);
    const original = input.project(board, { scope: view.scope, workspaceId: input.workspaceId, issueId, nativeChanges });
    const frame = projectOrganizationExactFeedbackFrame(original, nativeChanges);
    if (frame === undefined) continue;

    sourceRefs.push(frame.sourceRef);

    for (const unit of indexOrganizationDomainRows(frame, { scope: view.scope,
      ...(input.secrets === undefined ? {} : { secrets: input.secrets }) })) {
      const previous = priorUnits.get(unitKey(unit.feedback)) ?? [];
      const owners = new Map<string, OrganizationFeedbackRelation>();

      for (const ref of unit.references) {
        const related = relations.byReference.get(ref);
        for (const decisionRef of related?.selected_by ?? []) if (!owners.has(decisionRef)) owners.set(decisionRef, "selected_by");
        for (const decisionRef of related?.produced_by ?? []) owners.set(decisionRef, "produced_by");
      }

      if (owners.size === 0) {
        // A legacy source-bound background fact needs one stable anchor, never
        // a fictitious producer or one duplicate sample per later decision.
        const existing = previous.find(row => decisions.some(decision => decision.value.decisionRef === row.value.decisionRef));
        const anchor = existing?.value.decisionRef ?? decisions.find(row => (safeReferences.get(row.value.decisionRef) ?? [])
          .some(ref => unit.references.includes(ref)))?.value.decisionRef ?? decisions[0]!.value.decisionRef;
        owners.set(anchor, "related_background");
      }

      // Existing legacy associations must follow the original unit's correction
      // too. Updating their head does not turn background into a producer, or
      // create a new association for every later same-issue thought.
      for (const row of previous) if (!owners.has(row.value.decisionRef)) owners.set(row.value.decisionRef, "related_background");

      for (const [decisionRef, relation] of owners) {
        const feedback = { ...unit.feedback, decisionRef };
        entries.set(organizationFeedbackKey(feedback), { feedback, relation });
      }
    }
  }

  for (const decision of relevant) for (const feedback of projectOrganizationCosts(board, view, decision, safeReferences)) {
    entries.set(organizationFeedbackKey(feedback), { feedback, relation: "related_background" });
  }

  return { entries: [...entries.values()], background, sourceRefs: unique(sourceRefs), decisions: relevant, safeReferences };
}
