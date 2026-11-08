import type { LearningIssue } from "../../../learning/control/coordination-contract.js";
import type { BoardState } from "../../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { methodFocusedTarget } from "../../../learning/agent/subsystems/method/adapters/index.js";
import type { ContentMaterialBatch } from "../../../learning/central/content/material-contract.js";
import { pageContentMaterial, type ContentMaterialPage } from "./artifact-read.js";
import { readSessionContentAddress, sessionContentAddress, sessionTaskAddress } from "./session-address.js";
import { learningIssueOwner } from "../../../learning/control/learning-issue-owner.js";

interface Entry { readonly ref: string; readonly sourceRefs: readonly string[]; readonly originalScope: string; readonly role: string }

function originalAddresses(issue: LearningIssue, board?: BoardState): readonly Entry[] {
  const refs = new Map<string, Entry>(), target = methodFocusedTarget(issue);
  const add = (ref: string, sourceRef: string, originalScope: string, role: string) => {
    if (!refs.has(ref)) refs.set(ref, { ref, sourceRefs: [sourceRef], originalScope, role });
  };

  for (const report of issue.reports) {
    const source = report.source;
    const explicit = report.evidenceRefs.filter(ref => readSessionContentAddress(ref) !== undefined);

    for (const ref of explicit) add(ref, report.reportId, issue.scope, "original_report_explicit_session_address");

    if ("kind" in source) continue; // A research request owns references, never a business session/task identity.

    // Modern PA taskId may identify a session/team. Its actual born address owns
    // journal routing; only legacy reports need the former task/turn fallback.
    if (!("subsystem" in source)) {
      if (explicit.length === 0) add(sessionTaskAddress(source.taskId), report.reportId, issue.scope, "original_team_task");
      continue;
    }

    if (source.subsystem === "workflow") continue; // Its taskId is a budget ID; the original evidence URI owns journal routing.

    if (explicit.length === 0 && source.subsystem === "skill" && report.evidenceRefs.some(ref => ref.startsWith("skill-task:"))) {
      add(sessionContentAddress({ sessionId: source.versionId, turnId: source.taskId }), report.reportId, issue.scope, "canonical_skill_task_report");
      continue;
    }

    if (explicit.length === 0) add(sessionTaskAddress(source.taskId), report.reportId, issue.scope, "original_report_task_not_assumed_learning_origin");

    if (source.subsystem !== "method" || board === undefined || target === undefined || target.versionId !== source.versionId) continue;

    const scopeId = target.scopeId;

    for (const fielding of [...board.fieldings].reverse()) if (fielding.versionId === target.versionId && fielding.scope === scopeId) {
      add(sessionTaskAddress(fielding.turnId), fielding.exposureId, fielding.scope, "actual_method_fielding_task");
    }

    for (const fact of [...(board.methodExperienceFacts ?? [])].reverse()) {
      if (fact.versionId !== target.versionId) continue;
      if (fact.kind === "decision" && fact.decision.scopeId === scopeId) add(sessionTaskAddress(fact.context.taskId), fact.factId, scopeId, "scoped_method_decision_task");
      if (fact.kind === "execution" && fact.trace.scopeId === scopeId) add(sessionTaskAddress(fact.trace.taskId), fact.factId, scopeId, "scoped_method_execution_task");
    }

    for (const exposure of [...(board.rewardExposures ?? [])].reverse()) {
      if (exposure.context.scope !== scopeId && exposure.context.scope !== issue.scope) continue;
      if (!exposure.targets.some(item => item.version === target.versionId)) continue;
      add(sessionContentAddress({ sessionId: exposure.source.sessionId, turnId: exposure.source.turnId }), exposure.id, exposure.context.scope, "scoped_reward_source_task");
    }
  }

  return [...refs.values()];
}

export function sessionSourceAddressCatalogForIssue(issue: LearningIssue, board?: BoardState, start = 0, maximum = 16) {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64) throw new Error("content_issue_source_range_invalid");
  const all = originalAddresses(issue, board);
  const ref = `session-issue-source-catalog:${contentHashOf({ issueId: issue.issueId, scope: issue.scope, entries: all })}`;
  const entries = all.slice(start, start + maximum);
  return { ref, issueId: issue.issueId, scope: issue.scope, available: all.length, start, shown: entries.length,
    omitted: all.length - entries.length, nextStart: start + entries.length < all.length ? start + entries.length : null, entries };
}

/** Adapt owner-linked source identities. Bounded original tasks plus a discoverable full catalog avoid unbounded history transport. */
export function sessionSourceAddressesForIssue(issue: LearningIssue, board?: BoardState): readonly string[] {
  const catalog = sessionSourceAddressCatalogForIssue(issue, board, 0, 2);
  return catalog.available === 0 ? [] : [catalog.ref, ...catalog.entries.map(entry => entry.ref)];
}

export function sessionIssueSourceCatalogMaterial(issue: LearningIssue, board?: BoardState): ContentMaterialBatch {
  const catalog = sessionSourceAddressCatalogForIssue(issue, board);
  const text = canonicalJson({ role: "canonical_issue_source_address_catalog_not_problem_or_answer_identity", ...catalog,
    read: { ref: catalog.ref, start: 0, maximumChars: 8192 }, interpretation: "Addresses preserve original scope and provenance; undisplayed entries remain readable at the full catalog source." });
  const ref = `session-issue-source-manifest:${contentHashOf(text)}`;
  const owner = learningIssueOwner(issue);

  return { records: [{ ref, runId: ref, sequence: 0, scope: issue.scope, origin: "execution_result", text }],
    requirements: [], answers: [], materials: [{ id: ref, kind: "context", subsystem: owner === "ambiguous" ? "collaboration" : owner,
      context: "Owner-linked original source addresses, not a semantic same-question decision or an expanded workspace grant.",
      recordRefs: [ref, catalog.ref], requirementIds: [], answerIds: [], links: { issueIds: [issue.issueId], topicIds: [], artifactRefs: [] } }] };
}

export function readIssueSessionSourceCatalog(board: BoardState, scope: string, ref: string, start = 0, maximumChars = 4096): ContentMaterialPage | undefined {
  for (const issue of board.learningIssues ?? []) {
    if (issue.scope !== scope) continue;

    const catalog = sessionSourceAddressCatalogForIssue(issue, board);
    if (catalog.ref !== ref) continue;

    const text = canonicalJson({ role: "full_canonical_issue_source_address_catalog", issueId: issue.issueId, scope,
      entries: originalAddresses(issue, board), interpretation: "Source-owner addresses only; original source text is read through its journal owner." });

    return pageContentMaterial({ ref, requestedRef: ref, text, originalScope: scope, sourceRefs: [issue.issueId], admissibility: "source_record",
      origin: "execution_result", coordinate: { runId: ref, sequence: 0 } }, start, maximumChars);
  }
  return undefined;
}
