import type { BoardState } from "../../../../control/state.js";
import type { ContentDomainFeedbackChange } from "../../../../../integration/learning-content/sources/domain-feedback.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
import { contentHashOf } from "../../../../control/hash.js";
import { isCollaborationExperienceContent } from "../experience/parse.js";
import { experienceOwnerFingerprint } from "../experience/policy.js";
import { isCollaborationPlan } from "../orchestration/parse.js";
import { isCollaborationPracticeV2 } from "../domain/v2-parse.js";

type Unit = { readonly issueId: string; readonly versionId: string; readonly familyId: string;
  readonly experienceOwner?: string; readonly legacy: boolean };

/** Native post-delivery facts only. Published research is an index into its
 * original issue, not a delivery, adoption, quality result or new feedback. */
export function projectCollaborationCentralFeedbackChanges(board: BoardState, input: { readonly scope: string }): readonly ContentDomainFeedbackChange[] {
  const issues = new Map((board.learningIssues ?? []).filter(issue => issue.scope === input.scope && learningIssueOwner(issue) === "collaboration")
    .map(issue => [issue.issueId, issue]));
  const references = new Map<string, Set<string>>();

  for (const issue of issues.values()) for (const report of issue.reports) for (const ref of [report.reportId, ...report.evidenceRefs]) {
    const bound = references.get(ref) ?? new Set<string>();
    bound.add(issue.issueId);
    references.set(ref, bound);
  }

  const assets = new Map(board.assets.filter(asset => asset.scope === input.scope).map(asset => [asset.versionId, asset]));
  const owners = new Map(board.proposals.map(proposal => [proposal.proposalId, proposal]));
  const units = new Map<string, Unit[]>(), proposals = new Map<string, Unit[]>(), legacyFamilies = new Map<string, Unit[]>();

  for (const asset of assets.values()) {
    const content = asset.content;
    let bound: Unit[] = [];

    if (isCollaborationExperienceContent(content) || isCollaborationPlan(content)) {
      const proposal = asset.createdFromProposalId === undefined ? undefined : owners.get(asset.createdFromProposalId);
      if (proposal?.domain !== "collaboration" || proposal.scope !== input.scope || proposal.candidateRef !== asset.versionId
        || contentHashOf(content) !== asset.contentHash) continue;

      const issue = issues.get(content.issueId);
      if (issue === undefined || content.focusRevision > issue.revision) continue;

      if (isCollaborationExperienceContent(content)) {
        if (content.owner.kind === "legacy_member" && content.owner.workspace !== input.scope) continue;
        const parent = content.parentVersionId === undefined ? undefined : assets.get(content.parentVersionId)?.content;
        if (content.parentVersionId !== undefined && (!isCollaborationExperienceContent(parent) || parent.familyId !== content.familyId
          || experienceOwnerFingerprint(parent.owner) !== experienceOwnerFingerprint(content.owner))) continue;
      } else if (!content.experienceVersionIds.every(id => assets.has(id))) continue;

      bound = [{ issueId: issue.issueId, versionId: asset.versionId, familyId: content.familyId, legacy: false,
        ...(isCollaborationExperienceContent(content) ? { experienceOwner: experienceOwnerFingerprint(content.owner) } : {}) }];
    } else if (isCollaborationPracticeV2(content)) {
      if (contentHashOf(content) !== asset.contentHash) continue;
      // A family-name match is not native provenance. Older practice versions
      // enter only through an exact original issue report's version reference.
      bound = [...(references.get(asset.versionId) ?? [])].map(issueId => ({ issueId, versionId: asset.versionId, familyId: content.familyId, legacy: true }));
      const family = legacyFamilies.get(content.familyId) ?? [];
      family.push(...bound);
      legacyFamilies.set(content.familyId, family);
    }

    if (bound.length > 0) { units.set(asset.versionId, bound);
      if (asset.createdFromProposalId !== undefined) proposals.set(asset.createdFromProposalId, bound); }
  }

  const result: ContentDomainFeedbackChange[] = [], seen = new Set<string>();
  const append = (unit: Unit, factRef: string, kind: ContentDomainFeedbackChange["kind"], sourceRefs: readonly string[], revisionRef = factRef) => {
    const key = [unit.issueId, factRef, unit.versionId, revisionRef].join("\0");
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ domain: "collaboration", issueId: unit.issueId, factRef, unitRef: unit.versionId, revisionRef, kind,
      sourceRefs: [...new Set([factRef, unit.versionId, ...sourceRefs])] });
  };
  const receipts = new Map((board.collaborationRuntimeReceipts ?? []).filter(receipt => receipt.scope === input.scope).map(receipt => [receipt.receiptId, receipt]));

  for (const receipt of receipts.values()) {
    if (!("versionIds" in receipt)) continue; // Resource queries are research progress, not use feedback.

    const owner = experienceOwnerFingerprint(receipt.owner);

    if (receipt.phase === "use_feedback") {
      const dispatched = receipts.get(receipt.usageReceiptId);
      if (dispatched?.phase !== "dispatched" || experienceOwnerFingerprint(dispatched.owner) !== owner
        || dispatched.versionIds.length !== receipt.versionIds.length || !receipt.versionIds.every(id => dispatched.versionIds.includes(id))) continue;
    }

    for (const versionId of receipt.versionIds) for (const unit of units.get(versionId) ?? []) {
      if (unit.experienceOwner !== owner) continue;
      append(unit, receipt.receiptId, receipt.phase === "use_feedback" ? "quality" : "delivery",
        receipt.phase === "use_feedback" ? [receipt.usageReceiptId, ...receipt.sourceRefs] : []);
    }
  }

  const facts = new Map((board.collaborationV2Facts ?? []).filter(fact => fact.scope === input.scope).map(fact => [fact.factId, fact]));
  const exposures = new Map<string, Unit[]>(), adoptions = new Map<string, Unit[]>();

  for (const fact of facts.values()) {
    if (fact.kind === "exposure") {
      const bound = (units.get(fact.versionId) ?? []).filter(unit => unit.legacy);
      exposures.set(fact.factId, bound);
      for (const unit of bound) append(unit, fact.factId, "delivery", [fact.versionId]);
    } else if (fact.kind === "adoption") {
      const exposure = facts.get(fact.exposureId);
      if (exposure?.kind !== "exposure" || !exposure.actionIds.includes(fact.actionId) || !fact.eventIds.every(id => facts.get(id)?.kind === "event")) continue;
      const bound = exposures.get(fact.exposureId) ?? [];
      adoptions.set(fact.factId, bound);
      for (const unit of bound) append(unit, fact.factId, "adoption", [fact.exposureId, ...fact.eventIds]);
    } else if (fact.kind === "outcome") {
      for (const adoption of fact.adoptionIds) for (const unit of adoptions.get(adoption) ?? []) {
        append(unit, fact.factId, "quality", [...fact.adoptionIds, ...fact.episodeIds, ...fact.evidenceRefs]);
      }
    } else if (fact.kind === "correction") {
      for (const unit of legacyFamilies.get(fact.familyId) ?? []) append(unit, fact.factId, "correction",
        [fact.evidenceRef, ...(fact.replacesCorrectionId === undefined ? [] : [fact.replacesCorrectionId])]);
    }
  }

  const grants = new Map((board.centralLearningGrants ?? []).map(grant => [grant.grantId, grant])), jobs = new Map(board.jobs.map(job => [job.jobId, job]));

  for (const dependency of board.learningDependencies ?? []) {
    if (dependency.state.kind === "waiting" || dependency.state.kind === "unavailable") continue;

    const issue = issues.get(dependency.issueId), grant = grants.get(dependency.grantId), job = jobs.get(dependency.jobId);
    if (issue === undefined || grant?.scope !== input.scope || grant.issueId !== issue.issueId || grant.jobId !== dependency.jobId
      || (grant.domain ?? "collaboration") !== "collaboration" || job?.scope !== input.scope || job.domain !== "collaboration"
      || job.coordination?.issueId !== issue.issueId || job.coordination.grantId !== grant.grantId || grant.focusRevision > issue.revision) continue;

    result.push({ domain: "collaboration", issueId: issue.issueId, factRef: dependency.dependencyId, unitRef: dependency.dependencyId,
      revisionRef: `${dependency.dependencyId}:revision:${dependency.revision}`, kind: "dependency",
      sourceRefs: [dependency.dependencyId, dependency.grantId, dependency.jobId,
        ...(dependency.state.kind === "ready" ? [dependency.state.resultRef, ...dependency.state.evidenceRefs]
          : dependency.state.kind === "authorized" ? [dependency.state.authorizationRef] : [])] });
  }

  for (const tombstone of board.tombstones) {
    if (tombstone.entityType !== "asset" && tombstone.entityType !== "proposal") continue;
    const bound = tombstone.entityType === "asset" ? units.get(tombstone.entityId) : proposals.get(tombstone.entityId);
    for (const unit of bound ?? []) append(unit, tombstone.entityId, "correction", [], `${tombstone.entityId}:revision:${tombstone.boardSequence}`);
  }

  return result;
}
