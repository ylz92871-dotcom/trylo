import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralLearningAgentDomain, LearningIssue } from "../../learning/control/coordination-contract.js";
import type { BoardState } from "../../learning/control/state.js";
import type { CentralLearningSubject, CentralRuntimeMaterial, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { evolution } from "../../learning/agent/subsystems/tool/index.js";
import { workflowImprovementRecordId, type WorkflowImprovementOpportunityRecord } from "../../learning/agent/subsystems/workflow/adapters/improvement-board.js";
import { parseWorkflowImprovementEvidence, parseWorkflowOpportunity } from "../../learning/agent/subsystems/workflow/improvement/parse.js";
import { originalLearningIssueRefs } from "./organization-feedback-references.js";
import { centralResearchRequestRef } from "./research-intake-common.js";
import { readCentralResearchEpisodeOrigin } from "./research-intake-origin.js";
import { centralSourceReadScopes } from "./runtime-source-changes.js";
import { readRuntimePublicSourceFrame } from "./runtime-source-frames.js";
import { readCentralRuntimePrefix } from "../../learning/central/runtime/records.js";

type Query = NonNullable<Parameters<CentralRuntimeSourcePort["snapshot"]>[2]>;

interface Origin { readonly requests: readonly { readonly ref: string; readonly domain: CentralLearningAgentDomain }[];
  readonly intentRefs: readonly string[] }

/** Source roles come from canonical requests/plans, never a text prefix, amount
 * of money or resemblance between two problem statements. */
export function centralNativeSourceRelations(board: BoardState, scope: string, issues: readonly LearningIssue[], query?: Query,
  compatibleScopes: readonly string[] = [], secrets: readonly string[] = []) {
  const allowedScopes = centralSourceReadScopes(scope, compatibleScopes);
  const origins = new Map<string, Origin>();

  for (const issue of issues) {
    const reports: Origin[] = [];

    for (const report of issue.reports) {
      const source = report.source;
      if ("kind" in source) {
        reports.push({ intentRefs: [source.intentRef], requests: [{ ref: source.requestRef, domain: source.domain }] });
        continue;
      }

      if (!("subsystem" in source)) break;

      if (source.subsystem === "tool") {
        const asset = board.assets.find(row => row.versionId === evolution.planVersionId(source.versionId));
        if (asset === undefined) break;

        const plan = evolution.decodeToolLearningPlan(asset.content);
        if (plan === undefined || contentHashOf(asset.content) !== asset.contentHash
          || asset.scope !== plan.scope || evolution.toolLearningJobId(plan) !== source.versionId) throw new Error("central_native_tool_source_invalid");

        if (plan.trigger.action !== "central_research") break;

        const episode = readCentralResearchEpisodeOrigin(issue, plan.trigger.proposalKey);

        reports.push({ intentRefs: episode === undefined ? [] : [episode.intentRef], requests: [{ ref: plan.trigger.proposalKey, domain: "tool" }] });
        continue;
      }

      if (source.subsystem === "workflow") {
        const opportunity = originalWorkflowOpportunity(board, source.versionId);
        if (opportunity?.trigger !== "central_research") break;
        const episode = readCentralResearchEpisodeOrigin(issue, opportunity.opportunityId);
        reports.push({ intentRefs: episode === undefined ? [] : [episode.intentRef], requests: [{ ref: opportunity.opportunityId, domain: "workflow" }] });
        continue;
      }

      break;
    }

    // The original creation report owns this handoff's lineage. Appended native
    // observations must not erase that lineage and create another Agent agenda.
    if (reports.length > 0) origins.set(issue.issueId, {
      requests: reports.flatMap(row => row.requests),
      intentRefs: [...new Set(reports.flatMap(row => row.intentRefs))],
    });
  }

  const bindings = [...(query?.purposes ?? [])];

  for (const subject of query?.subjects ?? []) {
    if (!bindings.some(row => canonicalJson(row.subject) === canonicalJson(subject))) bindings.push({ subject, sourceRefs: query?.sourceRefs ?? [] });
  }

  const subjectsByIssue = new Map<string, CentralLearningSubject[]>();
  const explicit = new Set((query?.purposes ?? []).map(row => canonicalJson(row.subject)));
  // All locators below belong to this one immutable Board prefix. Verify its
  // original runtime chain once, then follow exact material references locally;
  // a transitive lineage must not replay the whole history for each edge.
  const originals = new Map<string, CentralRuntimeMaterial>();

  if (bindings.length > 0) for (const row of readCentralRuntimePrefix(board.rewardV2Facts ?? [], scope, board.sequence)) {
    for (const material of row.state.materials) originals.set(material.ref, material);
  }

  for (const binding of bindings) {
    const native = new Set<string>(), seen = new Set<string>(), pending = [...binding.sourceRefs];

    for (let index = 0; index < pending.length; index += 1) {
      const ref = pending[index]!;
      if (seen.has(ref)) continue;

      if (seen.size >= 1024) throw new Error("central_native_source_reference_capacity");
      seen.add(ref);

      for (const originalScope of allowedScopes) for (const issueRef of originalLearningIssueRefs(board, originalScope, [ref])) native.add(issueRef);

      // Only explicitly cited locators and verified primary runtime records are
      // followed. A cache existing elsewhere is no read or consumption proof.
      const frame = readRuntimePublicSourceFrame(board, { scope, ref, secrets });
      if (frame !== undefined && typeof frame.origin.issueId === "string") native.add(frame.origin.issueId);

      const archived = originals.get(ref);
      if (archived !== undefined) pending.push(...archived.sourceRefs);
    }

    for (const issue of issues) {
      const origin = origins.get(issue.issueId), subject = binding.subject;
      const primary = issue.scope === scope;
      if (!primary && !(subject.plane === "central" && explicit.has(canonicalJson(subject)) && native.has(issue.issueId))) continue;

      const direct = primary && subject.plane === "agent" && subject.issueId === issue.issueId;
      const purpose = subject.plane === "central" && (primary && origin?.intentRefs.includes(subject.questionRef) === true
        || origin?.requests.some(row => row.ref === centralResearchRequestRef(scope, subject.questionRef, row.domain)) === true || native.has(issue.issueId));
      if (!direct && !purpose && !(subject.plane === "agent" && native.has(issue.issueId))) continue;

      const current = subjectsByIssue.get(issue.issueId) ?? [];
      if (!current.some(row => canonicalJson(row) === canonicalJson(subject))) current.push(subject);

      subjectsByIssue.set(issue.issueId, current);
    }
  }

  return { handoffs: new Set(origins.keys()), subjectsByIssue };
}

/** Decode one original source identity, without constructing the whole workflow
 * library view or reading unrelated procedures, uses and feedback bodies. */
function originalWorkflowOpportunity(board: BoardState, versionId: string) {
  const asset = board.assets.find(row => row.versionId === versionId), value = asset?.content;
  if (asset === undefined || typeof value !== "object" || value === null || !("type" in value)
    || value.type !== "workflow_improvement_opportunity") return undefined;

  if (!("schemaVersion" in value) || value.schemaVersion !== 1 || !("opportunity" in value) || !("evidence" in value)) {
    throw new Error("central_native_workflow_source_invalid");
  }

  const opportunity = parseWorkflowOpportunity(value.opportunity), evidence = parseWorkflowImprovementEvidence(value.evidence);
  if (!opportunity.ok) throw new Error(opportunity.code);
  if (!evidence.ok) throw new Error(evidence.code);

  const parent = "parentVersionId" in value ? value.parentVersionId : undefined;
  if (parent !== undefined && typeof parent !== "string") throw new Error("central_native_workflow_source_invalid");

  const record: WorkflowImprovementOpportunityRecord = { type: "workflow_improvement_opportunity", schemaVersion: 1,
    opportunity: opportunity.value, evidence: evidence.value, ...(parent === undefined ? {} : { parentVersionId: parent }) };
  const proposal = board.proposals.find(row => row.proposalId === asset.createdFromProposalId);
  if (asset.kind !== "workflow" || asset.scope !== record.opportunity.task.scope || contentHashOf(value) !== asset.contentHash
    || contentHashOf(record) !== asset.contentHash || workflowImprovementRecordId(record) !== asset.versionId
    || proposal?.domain !== "workflow" || proposal.scope !== asset.scope || proposal.assetKind !== "workflow") {
    throw new Error("central_native_workflow_source_invalid");
  }

  return record.opportunity;
}
