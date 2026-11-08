import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { CollaborationExperienceContent } from "./contracts.js";
import { isCollaborationExperienceContent } from "./parse.js";
import { collaborationDependencySourceRefs } from "../domain/dependency-evidence.js";

/** Historical qualification does not disappear when PA later resolves the original problem. */
export function collaborationExperienceSourcesValid(state: BoardState, scope: string, content: CollaborationExperienceContent): boolean {
  const issue = state.learningIssues?.find(item => item.issueId === content.issueId && item.scope === scope);
  if (issue === undefined || content.focusRevision > issue.revision
    || content.owner.kind === "legacy_member" && content.owner.workspace !== scope) return false;

  if (content.parentVersionId !== undefined && !state.assets.some(asset => asset.versionId === content.parentVersionId
    && asset.scope === scope && isCollaborationExperienceContent(asset.content) && asset.content.familyId === content.familyId
    && contentHashOf(asset.content.owner) === contentHashOf(content.owner))) return false;

  const refs = new Set(issue.reports.flatMap(report => [report.reportId, ...report.evidenceRefs]));

  for (const ref of collaborationDependencySourceRefs(state, { scope, issueId: content.issueId, focusRevision: content.focusRevision })) refs.add(ref);

  for (const receipt of state.collaborationRuntimeReceipts ?? []) {
    if (receipt.scope === scope && receipt.phase === "resource_result" && receipt.issueId === content.issueId) {
      refs.add(receipt.receiptId);
      for (const ref of receipt.resultRefs) refs.add(ref);
    }
    if (receipt.scope === scope && receipt.phase === "use_feedback" && contentHashOf(receipt.owner) === contentHashOf(content.owner)) {
      refs.add(receipt.receiptId);
      for (const ref of receipt.sourceRefs) refs.add(ref);
    }
  }

  for (const fact of state.collaborationV2Facts ?? []) {
    if (fact.scope === scope && fact.kind === "event" && fact.source === "runtime"
      && (fact.action === "resource_query" || fact.action === "resource_query_result")) {
      refs.add(fact.factId);
      for (const ref of fact.evidenceRefs) refs.add(ref);
    }
  }

  return content.sourceRefs.every(ref => refs.has(ref));
}

/** Used by the shared commit owner for an atomic final focus check. */
export function collaborationExperiencePublicationValid(state: BoardState, scope: string, content: CollaborationExperienceContent): boolean {
  const issue = state.learningIssues?.find(item => item.issueId === content.issueId && item.scope === scope);
  return issue?.decision.kind === "focused_learning" && issue.decision.revision === content.focusRevision
    && collaborationExperienceSourcesValid(state, scope, content);
}
