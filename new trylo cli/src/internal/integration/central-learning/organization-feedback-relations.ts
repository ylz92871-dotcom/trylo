import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import type { CentralLearningGrant } from "../../learning/control/coordination-contract.js";
import type { OrganizationDecision, OrganizationProjection } from "../../learning/central/organization/contracts.js";
import type { CentralCompletedOperation } from "../../learning/central/runtime/contracts.js";
import { readCentralRuntimeCompletedIndex } from "../../learning/central/runtime/records.js";
import { centralOrganizationDeliberationRef } from "./organization-feedback-runtime.js";
import { readRuntimeAgentWork } from "./runtime-agent-execution-frame.js";
import type { OrganizationProductionProof } from "./organization-feedback-production-evidence.js";

type Relation = "produced_by" | "selected_by" | "related_background";

type RelationRefs = { readonly [K in Relation]: readonly string[] };

export interface OrganizationDecisionRelations extends RelationRefs {
  readonly operationIds: readonly string[];
}

export interface OrganizationDecisionRelationIndex {
  readonly byDecision: ReadonlyMap<string, OrganizationDecisionRelations>;
  /** Values are decision refs. Background alone never establishes ownership. */
  readonly byReference: ReadonlyMap<string, RelationRefs>;
}

type MutableRefs = { [K in Relation]: Set<string> };

type CompletedRow = ReturnType<typeof readCentralRuntimeCompletedIndex>[number];

type Production = { readonly outputs: readonly string[]; readonly anchors: readonly string[] };

const emptyRefs = (): MutableRefs => ({ produced_by: new Set(), selected_by: new Set(), related_background: new Set() });
const sorted = (values: ReadonlySet<string>) => [...values].sort();
const originalRef = (ref: string) => !ref.startsWith("organization-") && !ref.startsWith("central-organization-")
  && !ref.startsWith("central-runtime-purpose-");
const operationPlanKey = (completed: CentralCompletedOperation) =>
  `central-runtime-intent-operation:${contentHashOf([completed.intentId, completed.operation.operationId])}:`;

/** A raw ID is not enough: old agendas also used raw operation IDs. The frozen
 * operation program and original intent distinguish a selected expectation. */
function isExpectation(decision: OrganizationDecision, completed: CentralCompletedOperation): boolean {
  return decision.decisionRef === completed.operation.operationId && decision.purposeRef === completed.intentId
    && decision.stageRefs.includes(completed.operation.operationId)
    && decision.program.programRef === `central-organization-program:${contentHashOf(canonicalJson(completed.operation))}`;
}

function confirmedProduction(scope: string, row: CompletedRow,
  grants: readonly CentralLearningGrant[], jobs: ReadonlyMap<string, BoardState["jobs"][number]>,
  issues: ReadonlyMap<string, NonNullable<BoardState["learningIssues"]>[number]>,
  grantsById: ReadonlyMap<string, CentralLearningGrant>, proof: OrganizationProductionProof | undefined): Production {
  const completed = row.completed, operation = completed.operation;
  if (operation.kind !== "dispatch" || operation.destination?.plane === "user") return { outputs: [], anchors: [] };

  const reported = new Set(completed.resultRefs), outputs = new Set<string>(), anchors = new Set<string>();
  let historical: ReturnType<typeof readRuntimeAgentWork> | undefined;

  if (row.work !== undefined) {
    try {
      historical = readRuntimeAgentWork(row.work, scope);
      if (row.work.intentId !== completed.intentId || canonicalJson(row.work.operation) !== canonicalJson(operation)) return { outputs: [], anchors: [] };
    } catch { return { outputs: [], anchors: [] }; } // Malformed original work never falls back to a mutable plan.
  }

  const originalGrant = historical === undefined ? undefined : grantsById.get(historical.input.grantId);
  const candidates = historical === undefined ? grants : originalGrant === undefined ? [] : [originalGrant];

  for (const grant of candidates) {
    const job = jobs.get(grant.jobId), issue = issues.get(grant.issueId), domain = grant.domain ?? "collaboration";
    if (grant.scope !== scope || historical === undefined && !reported.has(grant.grantId) && !reported.has(grant.jobId)
      || issue === undefined || issue.scope !== scope || grant.focusRevision > issue.revision
      || job === undefined || job.scope !== scope || job.domain !== domain
      || job.coordination?.grantId !== grant.grantId || job.coordination.issueId !== grant.issueId
      || operation.destination?.plane === "agent" && operation.destination.domain !== domain) continue;

    const owner = learningIssueOwner(issue);
    if ((owner === "method" ? "prompt" : owner) !== domain) continue;

    if (historical !== undefined && (historical.input.issueId !== grant.issueId || historical.input.offer.owner.plane !== "agent"
      || historical.input.offer.owner.domain !== domain || historical.budgetId !== grant.budgetId
      || historical.input.expectedIssueRevision < grant.focusRevision
      || historical.input.expectedIssueRevision > issue.revision)) continue;

    // Rebudget/close may change the current authorization and plan. Those govern
    // future investment, not the identity of a proven original stage's output.
    // A yielded research stage may already have published a real artifact. Its
    // exact original native proof survives later job states and result changes.
    const proven = historical !== undefined && proof !== undefined && proof.inputHash === historical.inputHash;
    const results = proven ? proof.outputs.filter(ref => reported.has(ref))
      : historical === undefined && job.state === "succeeded" ? (job.coordination.resultRefs ?? []).filter(ref => reported.has(ref)) : [];
    if (results.length === 0) continue;

    for (const ref of results) if (originalRef(ref)) outputs.add(ref);

    for (const ref of [operation.operationId, row.factRef, grant.grantId, grant.jobId,
      ...(row.work === undefined ? completed.resultRefs.filter(ref => /^central-runtime-work:[a-f0-9]{64}$/.test(ref)) : [row.work.workRef]),
      ...(historical === undefined ? [] : [historical.input.stageRef, historical.input.sourceBindingRef]),
      ...(proven ? proof.anchors : [])]) anchors.add(ref);
  }

  return { outputs: sorted(outputs), anchors: sorted(anchors) };
}

/** A temporary relation index over original facts, never a second ledger.
 * Dispatch outputs require the original work (or an exact legacy operation plan), native grant/job binding
 * and original native stage proof (legacy final jobs retain their old gate).
 * Read/consult returns, input refs,
 * money and same-issue membership remain background. No domain-progress summary
 * is allowed to manufacture a producer or selection relationship. */
export function buildOrganizationDecisionRelationIndex(board: BoardState, view: OrganizationProjection, original?: {
  readonly completed: readonly CompletedRow[]; readonly productions: ReadonlyMap<string, OrganizationProductionProof>;
}): OrganizationDecisionRelationIndex {
  const completed = new Map((original?.completed ?? readCentralRuntimeCompletedIndex(board.rewardV2Facts ?? [], view.scope, board.sequence))
    .map(row => [row.completed.operation.operationId, row]));
  const computations = new Map([...completed.values()].map(row =>
    [centralOrganizationDeliberationRef(view.scope, row.completed.operation.operationId), row]));
  const jobs = new Map(board.jobs.map(job => [job.jobId, job]));
  const issues = new Map((board.learningIssues ?? []).map(issue => [issue.issueId, issue]));
  const grantsById = new Map((board.centralLearningGrants ?? []).map(grant => [grant.grantId, grant]));
  const grantsByPlan = new Map<string, CentralLearningGrant[]>();

  for (const grant of board.centralLearningGrants ?? []) {
    const plan = /^central-runtime-intent-operation:([a-f0-9]{64}):[a-f0-9]{64}$/.exec(grant.planRef ?? "");
    if (plan === null) continue;
    const key = `central-runtime-intent-operation:${plan[1]}:`;
    const values = grantsByPlan.get(key) ?? [];
    values.push(grant);
    grantsByPlan.set(key, values);
  }

  const expectations = new Map<string, { readonly decision: OrganizationDecision; readonly production: Production }>();
  const mutable = new Map<string, MutableRefs>(), operations = new Map<string, Set<string>>();

  for (const stored of view.decisions) {
    const decision = stored.value, refs = emptyRefs(), operationIds = new Set<string>();

    for (const ref of [...decision.sourceRefs, ...decision.issueRefs, ...decision.stageRefs]) if (originalRef(ref)) refs.related_background.add(ref);

    const row = completed.get(decision.decisionRef);
    if (row !== undefined && isExpectation(decision, row.completed)) {
      operationIds.add(row.completed.operation.operationId);
      const production = confirmedProduction(view.scope, row, grantsByPlan.get(operationPlanKey(row.completed)) ?? [], jobs, issues, grantsById,
        original?.productions.get(row.completed.operation.operationId));

      expectations.set(decision.decisionRef, { decision, production });

      for (const ref of production.outputs) refs.produced_by.add(ref);

      for (const ref of [row.factRef, ...row.completed.operation.sourceRefs, ...row.completed.resultRefs, ...production.anchors]) {
        if (originalRef(ref)) refs.related_background.add(ref);
      }
    } else {
      // Canonical computation returns identify this computation only. Its output
      // agenda/text cannot be promoted into a native artifact production claim.
      const actual = computations.get(decision.decisionRef);
      if (actual !== undefined) {
        const operationId = actual.completed.operation.operationId;
        if (decision.purposeRef === operationId) {
          operationIds.add(operationId);
          for (const ref of [operationId, actual.factRef, ...actual.completed.operation.sourceRefs, ...actual.completed.resultRefs]) {
            if (originalRef(ref)) refs.related_background.add(ref);
          }
        }
      }
    }

    mutable.set(decision.decisionRef, refs);
    operations.set(decision.decisionRef, operationIds);
  }

  for (const stored of view.decisions) {
    const decision = stored.value, refs = mutable.get(decision.decisionRef)!;

    for (const selected of decision.stageRefs) {
      const expectation = expectations.get(selected);
      if (expectation === undefined || expectation.decision.decisionRef === decision.decisionRef) continue;
      for (const ref of [selected, ...expectation.production.outputs, ...expectation.production.anchors]) refs.selected_by.add(ref);
    }

    for (const ref of [...refs.produced_by, ...refs.selected_by]) refs.related_background.delete(ref);
  }

  const byDecision = new Map<string, OrganizationDecisionRelations>(), inverse = new Map<string, MutableRefs>();

  for (const [decisionRef, refs] of mutable) {
    byDecision.set(decisionRef, { operationIds: sorted(operations.get(decisionRef)!), produced_by: sorted(refs.produced_by),
      selected_by: sorted(refs.selected_by), related_background: sorted(refs.related_background) });
    for (const relation of ["produced_by", "selected_by", "related_background"] as const) for (const ref of refs[relation]) {
      const linked = inverse.get(ref) ?? emptyRefs();
      linked[relation].add(decisionRef);
      inverse.set(ref, linked);
    }
  }

  return { byDecision, byReference: new Map([...inverse].map(([ref, refs]) => [ref, {
    produced_by: sorted(refs.produced_by), selected_by: sorted(refs.selected_by), related_background: sorted(refs.related_background) }])) };
}
