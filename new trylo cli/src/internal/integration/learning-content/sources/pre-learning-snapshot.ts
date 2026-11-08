import type { ActivationRecord, LearningDomain } from "../../../learning/control/contracts.js";
import type { LearningIssue, LearningIssueSource } from "../../../learning/control/coordination-contract.js";
import type { BoardState } from "../../../learning/control/state.js";
import { contentHashOf } from "../../../learning/control/hash.js";
import { learningIssueOwner } from "../../../learning/control/learning-issue-owner.js";
import { methodFocusedTarget } from "../../../learning/agent/subsystems/method/adapters/index.js";
import { centralResponseRegistrationsOf, type CentralResponseRegistration } from "../../learning-allocation/response-registration.js";
import { freezePreLearningSourceSnapshot } from "./pre-learning-snapshot-parse.js";

export { isPreLearningSourceSnapshot, readPreLearningSourceSnapshot } from "./pre-learning-snapshot-parse.js";

type SourceReference = { readonly ref: string; readonly hash: string; readonly originalScope: string };

type Catalog<T> = { readonly available: number; readonly selected: readonly T[]; readonly omitted: number };

export interface PreLearningSourceSnapshot {
  readonly schemaVersion: 1;
  readonly kind: "pre_learning_source_snapshot";
  readonly snapshotId: string;
  readonly sourceHash: string;
  readonly knownAtBoardSequence: number;
  readonly scope: string;
  readonly issueId: string;
  readonly domain: LearningDomain;
  readonly qualification: "source_snapshot_not_counterfactual_or_learning_gain";
  readonly originalFocus: { readonly decisionRevision: number; readonly reasonHash: string; readonly sourceRefs: readonly string[] };
  readonly originalReports: Catalog<{ readonly reportId: string; readonly reportHash: string; readonly source: LearningIssueSource;
    readonly evidenceRefs: readonly string[] }>;
  readonly methodScope: { readonly versionId: string; readonly scopeId: string } | null;
  readonly assets: readonly { readonly versionId: string; readonly kind: string; readonly originalScope: string;
    readonly contentHash: string; readonly parentVersionId: string | null; readonly proposalRef: string | null }[];
  readonly sourceJobs: readonly { readonly jobId: string; readonly originalScope: string; readonly domain: LearningDomain;
    readonly attempt: number; readonly state: string; readonly observationRef: string; readonly originalDedupeKey: string }[];
  readonly sourceFacts: readonly { readonly ref: string; readonly sequence: number; readonly algorithmVersion: string; readonly payloadHash: string }[];
  readonly activePointers: readonly ActivationRecord[];
  readonly actualUses: { readonly methodFieldings: Catalog<SourceReference>; readonly toolUses: Catalog<SourceReference>;
    readonly rewardExposures: Catalog<SourceReference> };
  readonly responseRegistrations: Catalog<CentralResponseRegistration>;
  readonly missingSources: readonly { readonly ref: string; readonly reason: "external_or_unknown_source" | "active_asset_missing"
    | "method_scope_unresolved" | "source_report_catalog_omitted" }[];
  readonly sourceRefs: readonly string[];
}

export type PreLearningSnapshotResult = { readonly ok: true; readonly value: PreLearningSourceSnapshot }
  | { readonly ok: false; readonly reason: string };

/** Zero model/execution source freeze. It creates no reward, checker, comparison, population or EconomicContext. */
export function buildPreLearningSourceSnapshot(input: { readonly board: BoardState; readonly scope: string;
  readonly issueId: string; readonly domain?: LearningDomain }): PreLearningSnapshotResult {
  const { board, scope, issueId } = input;
  const issue = board.learningIssues?.find(row => row.scope === scope && row.issueId === issueId);
  if (issue === undefined) return { ok: false, reason: "pre_learning_issue_missing" };

  if (issue.decision.kind !== "focused_learning") return { ok: false, reason: "pre_learning_issue_not_focused" };

  const owner = learningIssueOwner(issue), domain = owner === "method" ? "prompt" : owner;
  if (domain === "ambiguous" || input.domain !== undefined && input.domain !== domain) return { ok: false, reason: "pre_learning_owner_mismatch" };

  // Research requests retain their own refs, not a fabricated business task/session identity.
  const reports = issue.reports.slice(-16), originalRefs = new Set(reports.flatMap(report => [
    ...("versionId" in report.source ? [report.source.versionId] : "taskId" in report.source ? [report.source.taskId]
      : [report.source.requestRef, report.source.intentRef]), ...report.evidenceRefs]));
  const sourceAssets = board.assets.filter(asset => originalRefs.has(asset.versionId));
  const pointers = board.activations.filter(pointer => sourceAssets.some(asset => asset.scope === pointer.scope && asset.kind === pointer.assetKind)
    && pointer.boardSequence <= board.sequence);
  const selectedAssets = board.assets.filter(asset => sourceAssets.includes(asset) || pointers.some(pointer => pointer.versionId === asset.versionId));
  if (selectedAssets.some(asset => contentHashOf(asset.content) !== asset.contentHash)) return { ok: false, reason: "pre_learning_asset_hash_mismatch" };

  const jobs = board.jobs.filter(job => originalRefs.has(job.jobId) && job.domain === domain);
  const facts = (board.rewardV2Facts ?? []).filter(fact => originalRefs.has(fact.id) && fact.sequence <= board.sequence);
  const methodScope = domain === "prompt" ? methodFocusedTarget(issue) ?? null : null;
  const uses = actualUseReferences(board, issue, selectedAssets, methodScope);
  const decoded = centralResponseRegistrationsOf(board, scope);
  if (decoded.status !== "ready") return { ok: false, reason: decoded.reason };

  const registrations = decoded.value.filter(record => board.centralLearningGrants?.some(grant => grant.grantId === record.window.grantId
    && grant.issueId === issueId && grant.scope === scope && (grant.domain ?? "collaboration") === domain));
  const missingSources: PreLearningSourceSnapshot["missingSources"][number][] = [];

  for (const ref of originalRefs) if (!sourceAssets.some(asset => asset.versionId === ref) && !facts.some(fact => fact.id === ref) && !jobs.some(job => job.jobId === ref)) {
    missingSources.push({ ref, reason: "external_or_unknown_source" });
  }

  for (const pointer of pointers) if (!selectedAssets.some(asset => asset.versionId === pointer.versionId)) missingSources.push({ ref: pointer.versionId, reason: "active_asset_missing" });

  if (domain === "prompt" && methodScope === null) missingSources.push({ ref: issueId, reason: "method_scope_unresolved" });

  if (reports.length !== issue.reports.length) missingSources.push({ ref: issueId, reason: "source_report_catalog_omitted" });

  const body: Omit<PreLearningSourceSnapshot, "sourceHash" | "snapshotId"> = { schemaVersion: 1, kind: "pre_learning_source_snapshot", knownAtBoardSequence: board.sequence,
    scope, issueId, domain, qualification: "source_snapshot_not_counterfactual_or_learning_gain" as const,
    originalFocus: { decisionRevision: issue.decision.revision, reasonHash: contentHashOf(issue.decision.reason), sourceRefs: issue.decision.sourceRefs },
    originalReports: { available: issue.reports.length, selected: reports.map(report => ({ reportId: report.reportId, reportHash: contentHashOf(report), source: report.source,
      evidenceRefs: report.evidenceRefs })), omitted: issue.reports.length - reports.length }, methodScope,
    assets: selectedAssets.map(asset => ({ versionId: asset.versionId, kind: asset.kind, originalScope: asset.scope, contentHash: asset.contentHash,
      parentVersionId: asset.parentVersionId ?? null, proposalRef: asset.createdFromProposalId ?? null })),
    sourceJobs: jobs.map(job => ({ jobId: job.jobId, originalScope: job.scope, domain: job.domain, attempt: job.attempt,
      state: job.state, observationRef: job.observationId, originalDedupeKey: job.dedupeKey })),
    sourceFacts: facts.map(fact => ({ ref: fact.id, sequence: fact.sequence, algorithmVersion: fact.algorithmVersion, payloadHash: contentHashOf(fact.payloadJson) })),
    activePointers: pointers, actualUses: uses, responseRegistrations: catalog(registrations, 16), missingSources,
    sourceRefs: [...new Set([issueId, ...reports.map(report => report.reportId), ...originalRefs, ...selectedAssets.map(asset => asset.versionId),
      ...pointers.map(pointer => pointer.activationId), ...jobs.map(job => job.jobId), ...facts.map(fact => fact.id),
      ...Object.values(uses).flatMap(value => value.selected.map(row => row.ref)), ...catalog(registrations, 16).selected.map(record => record.factId)])] };
  const sourceHash = contentHashOf(body), snapshot = structuredClone({ ...body, sourceHash, snapshotId: `pre-learning-source:${sourceHash}` });

  return { ok: true, value: freezePreLearningSourceSnapshot(snapshot) };
}

function actualUseReferences(board: BoardState, issue: LearningIssue, assets: readonly BoardState["assets"][number][],
  methodScope: { readonly versionId: string; readonly scopeId: string } | null): PreLearningSourceSnapshot["actualUses"] {
  const selected = (versionId: string) => assets.find(asset => asset.versionId === versionId);
  const fieldings = board.fieldings.filter(row => selected(row.versionId) !== undefined && methodScope !== null && row.scope === methodScope.scopeId);
  const tasks = new Set(fieldings.map(row => row.turnId));
  const toolUses = (board.toolUses ?? []).filter(row => {
    const asset = selected(row.versionId);
    return asset !== undefined && (row.scope === asset.scope || row.scope === issue.scope);
  });
  const exposures = (board.rewardExposures ?? []).filter(row => row.targets.some(target => selected(target.version) !== undefined)
    && (methodScope === null ? row.context.scope === issue.scope || assets.some(asset => asset.scope === row.context.scope)
      : row.context.scope === methodScope.scopeId || row.context.scope === issue.scope && tasks.has(row.source.turnId)));

  return { methodFieldings: catalog(fieldings.map(row => ({ ref: row.exposureId, hash: contentHashOf(row), originalScope: row.scope }))),
    toolUses: catalog(toolUses.map(row => ({ ref: row.useId, hash: contentHashOf(row), originalScope: row.scope }))),
    rewardExposures: catalog(exposures.map(row => ({ ref: row.id, hash: contentHashOf(row), originalScope: row.context.scope }))) };
}

function catalog<T>(values: readonly T[], maximum = 32): Catalog<T> { return { available: values.length, selected: values.slice(-maximum), omitted: Math.max(0, values.length - maximum) }; }
