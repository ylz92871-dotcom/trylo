import { contentHashOf } from "../../../../control/hash.js";
import type { LearningIssueReport } from "../../../../control/coordination-contract.js";
import type { CollaborationCentralResearchRequest } from "./central-research-record.js";

/** Every cited reference reaches the existing worker's known-source set. Native
 * report capacity is handled by several reports, never by dropping references. */
export function collaborationCentralResearchReports(request: CollaborationCentralResearchRequest, recordRef: string) {
  const problemKey = `central-research:${contentHashOf([request.scope, request.requestRef])}`;
  const issueId = `learning-issue:${contentHashOf([request.scope, problemKey])}`;
  const fixed = [...new Set([recordRef, request.requestRef, request.intentRef, request.intent.intentId])];
  const remaining = [...new Set([...request.sourceRefs, ...request.intent.sourceRefs, ...request.operation.sourceRefs,
    ...request.intent.knowledge.flatMap(item => item.sourceRefs), ...request.materials.flatMap(item => [item.ref, ...item.sourceRefs])])]
    .filter(ref => !fixed.includes(ref));
  const width = 32 - fixed.length, reports: LearningIssueReport[] = [];

  for (let offset = 0; offset < Math.max(1, remaining.length); offset += width) {
    const evidenceRefs = [...fixed, ...remaining.slice(offset, offset + width)];
    reports.push({ reportId: `collaboration-research-report:${contentHashOf([recordRef, offset, evidenceRefs])}`,
      source: { kind: "research_request", domain: "collaboration", requestRef: request.requestRef, intentRef: request.intentRef },
      facts: ["The central learning subject derived this collaboration research request from the cited original materials.",
        `Original public intent: ${request.intent.intentId}`,
        `Frozen research input: ${recordRef}`,
        "The frozen input preserves the original goal, conditions, knowledge, residual questions and proposed research operation; this report is an input reference, not a new business observation."],
      evidenceRefs });
  }

  return { issueId, problemKey, reports };
}
