import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { CentralLearningGrant, LearningIssue } from "../../learning/control/coordination-contract.js";
import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { readMethodResearch } from "../../learning/agent/subsystems/method/adapters/central-research-records.js";
import { centralSkillResearchFromBoard } from "../../learning/agent/subsystems/skill/control/central-research-board.js";
import { collaborationCentralResearchForIssue } from "../../learning/agent/subsystems/collaboration/control/central-research-context.js";
import { planForJob } from "../../learning/agent/subsystems/tool/runtime/pipeline-records.js";
import { parseWorkflowOpportunity } from "../../learning/agent/subsystems/workflow/improvement/parse.js";
import { CentralResearchIntakeError, type GroundedCentralResearch } from "./research-intake-common.js";
import { centralResearchReadSourceSignatures, type CentralResearchSourceReadScope } from "./research-intake-episode-sources.js";
import { CENTRAL_RESEARCH_PROGRAM as PROGRAM, CENTRAL_RESEARCH_EPISODE_META as META,
  centralResearchEpisodeMetadataMaterial, readCentralResearchEpisodeMetadata, readCentralResearchProgramReportMetadata,
  type CentralResearchEpisodePrevious as Previous, type CentralResearchEpisodeSelection as Selection,
  type CentralResearchEpisodeMetadata } from "./research-intake-episode-metadata.js";

export { centralResearchEpisodeMetadataMaterial, readCentralResearchEpisodeMetadata, readCentralResearchProgramReportMetadata,
  type CentralResearchEpisodeMetadata } from "./research-intake-episode-metadata.js";

import { readCentralResearchAssignedPrograms } from "./research-intake-episode-assignment.js";
import type { ContentDomainFeedbackReader } from "../learning-content/sources/domain-feedback-basis.js";
import { centralResearchNativeEvidenceIssueRefs, centralResearchReadNativeEvidenceSignatures } from "./research-intake-native-evidence.js";
import type { CentralResearchContinuation, CentralResearchContinuationReader } from "./research-intake-continuation.js";

interface Options { readonly boardRoot: string; readonly scope: string; readonly enabled: () => boolean;
  readonly readOwnerFeedback?: ContentDomainFeedbackReader; readonly readContinuation?: CentralResearchContinuationReader;
  readonly compatibleScopes?: readonly string[]; readonly readCompatibleScopes?: () => readonly string[] }

interface Episode { readonly issue: LearningIssue; readonly requestRef: string; readonly programRef: string | undefined;
  readonly programRefs: readonly string[]; readonly grant: CentralLearningGrant | undefined;
  readonly state: "open" | "terminal"; readonly previous: Previous | null;
  readonly metadata: ReadonlyMap<string, CentralResearchEpisodeMetadata> }

const fail = (reason: string, refs: readonly string[]): never => { throw new CentralResearchIntakeError(reason, refs); };
const words = (value: string) => value.trim();
const set = (values: readonly string[]) => [...new Set(values.map(words))].sort();

function programRef(request: Pick<GroundedCentralResearch, "intent" | "operation" | "materials">, scope: string,
  nativeEvidence: readonly string[] = [], sourceScope: CentralResearchSourceReadScope = {}) {
  const { intent, operation } = request;
  return `central-research-program:${contentHashOf({ goal: words(intent.goal), conditions: set(intent.conditions),
    knowledge: [...new Set(intent.knowledge.map(row => canonicalJson({ statement: words(row.statement), conditions: words(row.conditions) })))].sort(),
    residual: set(intent.residual), commitment: { purpose: words(intent.commitment.purpose), assumptions: set(intent.commitment.assumptions),
      reconsiderWhen: set(intent.commitment.reconsiderWhen) }, purpose: words(operation.purpose), expectedChange: words(operation.expectedChange),
    readSourceUnits: centralResearchReadSourceSignatures(request.materials, scope, sourceScope),
    ...(nativeEvidence.length === 0 ? {} : { nativeEvidenceUnits: [...new Set(nativeEvidence)].sort() }) })}`;
}

async function nativeEvidence(board: BoardState, options: Options, materials: readonly CentralRuntimeMaterial[], signal: AbortSignal) {
  const signatures: string[] = [];

  try {
    for (const issueId of centralResearchNativeEvidenceIssueRefs(materials, options.scope, board, options.compatibleScopes)) {
      if (!options.enabled() || signal.aborted) return fail("central_research_episode_inactive", [issueId]);
      const selected = await centralResearchReadNativeEvidenceSignatures({ board, scope: options.scope, issueId, materials,
        readOwnerFeedback: options.readOwnerFeedback ?? (async () => undefined),
        ...(options.compatibleScopes === undefined ? {} : { compatibleScopes: options.compatibleScopes }) }, signal);
      if (!options.enabled() || signal.aborted) return fail("central_research_episode_inactive", [issueId]);
      signatures.push(...selected);
    }
  } catch (error) {
    if (error instanceof CentralResearchIntakeError) throw error;
    return fail("central_research_episode_native_evidence_read_failed", []);
  }

  return [...new Set(signatures)].sort();
}

function sourceRequest(board: BoardState, issue: LearningIssue,
  request: Pick<GroundedCentralResearch, "domain"> & { readonly intent: Pick<CentralLearningIntentDraft, "intentId"> }, base: string) {
  const reports = issue.reports, direct = reports.flatMap(row => "kind" in row.source && row.source.kind === "research_request"
    && row.source.domain === request.domain && row.source.intentRef === request.intent.intentId ? [row.source.requestRef] : []);
  if (direct.length > 0) {
    const refs = [...new Set(direct)];
    if (refs.length !== 1) return fail("central_research_episode_source_ambiguous", [issue.issueId]);
    return refs[0];
  }

  const evidence = reports.flatMap(row => row.evidenceRefs);
  if (!evidence.includes(request.intent.intentId)) return undefined;

  const versions = [...new Set(reports.flatMap(row => "subsystem" in row.source ? [row.source.versionId] : []))];
  if (versions.length !== 1) return fail("central_research_episode_source_ambiguous", [issue.issueId]);

  if (request.domain === "tool") {
    const plan = planForJob(board, versions[0]!);
    return plan?.trigger.action === "central_research" && (plan.trigger.proposalKey === base || evidence.includes(base)) ? plan.trigger.proposalKey : undefined;
  }

  if (request.domain === "workflow") {
    const asset = board.assets.find(row => row.versionId === versions[0]);
    const body = asset?.content;
    if (typeof body !== "object" || body === null || !("type" in body) || body.type !== "workflow_improvement_opportunity"
      || !("opportunity" in body) || asset?.contentHash !== contentHashOf(body)) return fail("central_research_episode_native_source_invalid", [issue.issueId]);

    const opportunity = parseWorkflowOpportunity(body.opportunity);

    return opportunity.ok && opportunity.value.trigger === "central_research"
      && (opportunity.value.opportunityId === base || evidence.includes(base)) ? opportunity.value.opportunityId : undefined;
  }

  return undefined;
}

/** Decode the original native request before allowing a public report projection.
 * Tool/workflow use their actual plan/opportunity; the other owners verify their original stored request. */
export function readCentralResearchIssueRequestRef(board: BoardState, issue: LearningIssue,
  domain: GroundedCentralResearch["domain"], intentRef: string): string | undefined {
  if ((domain === "tool" || domain === "workflow") && issue.reports.some(report => "kind" in report.source)) return undefined;

  const base = `central-research-request:${contentHashOf([issue.scope, intentRef, domain])}`;
  const ref = sourceRequest(board, issue, { domain, intent: { intentId: intentRef } }, base);
  if (ref === undefined) return undefined;

  if (domain === "prompt" && readMethodResearch(board, issue.scope, ref)?.request.intent.intentId !== intentRef) return undefined;

  if (domain === "skill") {
    const read = centralSkillResearchFromBoard(board, issue.scope, ref);
    if (read.status !== "found" || read.request.intent.intentId !== intentRef) return undefined;
  }

  if (domain === "collaboration") {
    const read = collaborationCentralResearchForIssue(board, issue.scope, issue);
    if (read.status !== "ready" || read.request.requestRef !== ref || read.request.intent.intentId !== intentRef) return undefined;
  }

  return ref;
}

function snapshotProgram(board: BoardState, scope: string, issue: LearningIssue, requestRef: string, request: GroundedCentralResearch,
  sourceScope: CentralResearchSourceReadScope = { board }) {
  let original: { readonly intent: CentralLearningIntentDraft; readonly materials: readonly CentralRuntimeMaterial[] } | undefined;

  if (request.domain === "prompt") original = readMethodResearch(board, scope, requestRef)?.request;

  if (request.domain === "skill") {
    const source = centralSkillResearchFromBoard(board, scope, requestRef);
    if (source.status === "invalid") return fail(source.reason, [issue.issueId]);
    if (source.status === "found") original = source.request;
  }

  if (request.domain === "collaboration") {
    const source = collaborationCentralResearchForIssue(board, scope, issue);
    if (source.status === "rejected") return fail(source.reason, [issue.issueId]);
    if (source.status === "ready") original = source.request;
  }

  const continuation = original?.intent.continuation;
  const metadata = original === undefined ? undefined : readCentralResearchEpisodeMetadata(original.materials);

  return original === undefined || continuation?.kind !== "ready" || continuation.operation.kind !== "dispatch" ? undefined
    : { programRef: metadata?.programRef ?? programRef({ intent: original.intent, operation: continuation.operation, materials: original.materials }, scope, [], sourceScope),
      metadata, original: { intent: original.intent, operation: continuation.operation, materials: original.materials } };
}

function receptionMetadata(issue: LearningIssue, requestRef: string): ReadonlyMap<string, CentralResearchEpisodeMetadata> {
  const values = new Map<string, CentralResearchEpisodeMetadata>();

  for (const report of issue.reports) {
    const value = readCentralResearchProgramReportMetadata(report);
    if (value === undefined) continue;

    if (value.scope !== issue.scope || value.requestRef !== requestRef
      || report.reportId !== `central-research-program-report:${contentHashOf([issue.scope, issue.issueId, requestRef, value.programRef])}`) {
      return fail("central_research_program_metadata_invalid", [report.reportId]);
    }

    if (values.has(value.programRef)) return fail("central_research_program_metadata_ambiguous", [report.reportId]);

    values.set(value.programRef, value);
  }

  return values;
}

function episodeState(board: BoardState, issue: LearningIssue, grant: CentralLearningGrant | undefined, domain: GroundedCentralResearch["domain"]): Episode["state"] {
  const terminal = new Set(["succeeded", "failed", "cancelled", "expired"]);
  const centralJob = board.jobs.find(row => row.jobId === grant?.jobId);
  if (issue.grantId !== undefined && grant === undefined || grant !== undefined && (grant.issueId !== issue.issueId
    || grant.scope !== issue.scope || (grant.domain ?? "collaboration") !== domain || issue.jobId !== grant.jobId || centralJob === undefined)) {
    return fail("central_research_episode_original_owner_inspection_required", [issue.issueId]);
  }

  if (grant?.status === "closed" && !terminal.has(centralJob!.state)
    || grant?.status === "open" && centralJob !== undefined && terminal.has(centralJob.state)) {
    return fail("central_research_episode_original_owner_inspection_required", [issue.issueId, grant!.grantId]);
  }

  if (grant?.claim !== undefined || grant?.reservations.some(row => row.state === "reserved")) return "open";

  if (domain === "tool") {
    const nativeIds = [...new Set(issue.reports.flatMap(row => "subsystem" in row.source && row.source.subsystem === "tool" ? [row.source.versionId] : []))];
    const native = board.jobs.find(row => row.jobId === nativeIds[0]);
    if (nativeIds.length !== 1 || native === undefined) return fail("central_research_episode_native_source_invalid", [issue.issueId]);
    if (terminal.has(native.state)) return "terminal";
  }

  return grant?.status === "closed" || issue.decision.kind === "resolved" || issue.decision.kind === "ordinary_execution" ? "terminal" : "open";
}

function episodes(board: BoardState, scope: string, request: GroundedCentralResearch, base: string,
  sourceScope: CentralResearchSourceReadScope): readonly Episode[] {
  const rows: Episode[] = [];

  for (const issue of board.learningIssues ?? []) {
    if (issue.scope !== scope) continue;

    const owner = learningIssueOwner(issue), domain = owner === "method" ? "prompt" : owner;
    if (owner === "ambiguous" && issue.reports.some(row => row.evidenceRefs.includes(request.intent.intentId)
      || "kind" in row.source && row.source.intentRef === request.intent.intentId)) return fail("central_research_episode_source_ambiguous", [issue.issueId]);

    if (domain !== request.domain) continue;

    const ref = sourceRequest(board, issue, request, base);
    if (ref === undefined) continue;

    const evidence = issue.reports.flatMap(row => row.evidenceRefs);
    if (ref !== base && !evidence.includes(base)) continue;

    const markers = [...new Set(evidence.filter(value => PROGRAM.test(value)))];
    const snapshot = snapshotProgram(board, scope, issue, ref, request, sourceScope), metadata = snapshot?.metadata;
    if (metadata !== undefined && (metadata.baseRequestRef !== base || metadata.requestRef !== ref
      || metadata.intentRef !== request.intent.intentId || metadata.domain !== request.domain || metadata.scope !== scope)) return fail("central_research_episode_metadata_invalid", [issue.issueId]);

    const grant = board.centralLearningGrants?.find(row => row.grantId === issue.grantId);
    const admitted = new Map(receptionMetadata(issue, ref));

    for (const value of admitted.values()) if (value.baseRequestRef !== base || value.domain !== request.domain || value.intentRef !== request.intent.intentId) {
      return fail("central_research_program_metadata_invalid", [issue.issueId]);
    }

    const programs = [...new Set([...(snapshot === undefined ? [] : [snapshot.programRef]), ...markers])];

    if (metadata !== undefined && !admitted.has(metadata.programRef)) admitted.set(metadata.programRef, metadata);

    rows.push({ issue, requestRef: ref, programRef: programs.at(-1), programRefs: programs, grant,
      previous: metadata?.previous ?? null, metadata: admitted, state: episodeState(board, issue, grant, request.domain) });
  }

  return rows;
}

/** Select a native continuation using original Board sources only. This helper
 * never creates an issue/grant, refunds unknown costs or judges research value.
 */
export async function selectCentralResearchEpisode(options: Options, request: GroundedCentralResearch, signal: AbortSignal): Promise<GroundedCentralResearch> {
  const active = () => { if (!options.enabled() || signal.aborted) fail("central_research_episode_inactive", [request.requestRef]); };

  active();
  const original = readCentralResearchEpisodeMetadata(request.materials), base = original?.baseRequestRef ?? request.requestRef;
  if (original !== undefined && (original.scope !== options.scope || original.domain !== request.domain || original.intentRef !== request.intent.intentId)) {
    return fail("central_research_episode_metadata_invalid", [request.requestRef]);
  }

  const loaded = await createBoardReader(options.boardRoot).load();
  active();

  if (!loaded.ok) return fail(loaded.reason, [base]);

  let compatibleScopes: readonly string[];

  try { compatibleScopes = [...(options.readCompatibleScopes === undefined ? options.compatibleScopes ?? [] : options.readCompatibleScopes())]; }
  catch { return fail("central_research_episode_scope_proof_read_failed", [base]); }

  const readOptions = { ...options, compatibleScopes };
  const sourceScope = { acceptedScopes: compatibleScopes, board: loaded.state };
  const program = programRef(request, options.scope, await nativeEvidence(loaded.state, readOptions, request.materials, signal), sourceScope);
  active();
  let known: readonly Episode[];

  try { known = episodes(loaded.state, options.scope, request, base, sourceScope); }
  catch (error) {
    if (error instanceof CentralResearchIntakeError) throw error;
    return fail("central_research_episode_native_source_invalid", [base]);
  }

  const open = known.filter(row => row.state === "open");
  if (open.length > 1) return fail("central_research_episode_multiple_open_sources", open.map(row => row.issue.issueId));

  const assigned = await readCentralResearchAssignedPrograms({ boardRoot: options.boardRoot, scope: options.scope, board: loaded.state, sources: known,

    legacyProgramForReport: async (source, report) => {
      const native = known.find(row => row.issue.issueId === source.issue.issueId);
      const snapshot = native === undefined ? undefined : snapshotProgram(loaded.state, options.scope,
        { ...source.issue, reports: [report] }, native.requestRef, request, sourceScope);
      return snapshot === undefined ? undefined : snapshot.metadata?.programRef
        ?? programRef(snapshot.original, options.scope, await nativeEvidence(loaded.state, readOptions, snapshot.original.materials, signal), sourceScope);
    } }, signal);

  active();
  const matches = [...assigned.values()].flatMap(rows => rows.filter(row => row.programRef === program));
  if (matches.length > 0) {
    const current = open[0], latest = current === undefined ? undefined : [...(assigned.get(current.issue.issueId) ?? [])]
      .sort((a, b) => b.frozen.committedAtSequence - a.frozen.committedAtSequence || b.sequence - a.sequence)[0];
    let continuable = false;

    if (current?.grant !== undefined && latest?.programRef === program && options.readContinuation !== undefined) {
      let next: CentralResearchContinuation;

      try { next = await options.readContinuation({ board: loaded.state, scope: options.scope, issueId: current.issue.issueId,
        grantId: current.grant.grantId, programRef: program, lastStage: latest.frozen }, signal); }
      catch { return fail("central_research_continuation_inspection_required", latest.sourceRefs); }

      active();

      if (next.kind !== "continuable") return fail(next.reason, [...new Set([...latest.sourceRefs, ...next.sourceRefs])]);

      continuable = next.kind === "continuable" && !!next.cursorRef.trim()
        && !latest.frozen.candidate.source.domainStage.readiness.evidenceRefs.includes(next.cursorRef);
    }

    if (!continuable) return fail(matches.some(row => row.outcome === "pending")
      ? "already_assigned_outcome_unresolved" : "program_already_processed", [...new Set(matches.flatMap(row => row.sourceRefs))]);
  }

  let selectedRef = base, selection: Selection = "initial", previous: Previous | null = null;
  const current = open[0], match = current?.programRefs.includes(program) ? current : undefined, latest = known.at(-1);
  if (match !== undefined) {
    selectedRef = match.requestRef;
    selection = "reuse_program";
    previous = match.previous;
  }
  else if (current !== undefined) {
    selectedRef = current.requestRef;
    selection = current.programRef === undefined ? "legacy_program_unrecorded" : "reuse_open";
    previous = current.previous;
  }
  else if (latest !== undefined && latest.programRef === undefined) {
    selectedRef = latest.requestRef;
    selection = "legacy_program_unrecorded";
    previous = latest.previous;
  }
  else if (latest !== undefined) {
    previous = { issueId: latest.issue.issueId, grantId: latest.grant?.grantId ?? null, requestRef: latest.requestRef, programRef: latest.programRef ?? null };
    selectedRef = `central-research-episode:${contentHashOf([base, previous.issueId, previous.grantId, program])}`;
    selection = "derived_continuation";
  }

  let stored = match?.metadata.get(program) ?? current?.metadata.get(program);
  const draft: CentralResearchEpisodeMetadata = { schemaVersion: 1, role: "derived_central_research_episode_not_new_business_evidence", scope: options.scope,
    domain: request.domain, intentRef: request.intent.intentId, baseRequestRef: base, requestRef: selectedRef, programRef: program, selection, previous,
    interpretation: "derived_continuation_of_original_intent_not_new_business_observation_or_value_estimate" };
  const selectedKnown = match ?? current;
  if (stored === undefined && selectedKnown?.programRefs.includes(program)) {
    // Native tool plans retain the original metadata ref before the following
    // atomic reception report commits. Recover only by that exact original ref.
    const refs = new Set(selectedKnown.issue.reports.filter(row => !row.reportId.startsWith("central-research-program-report:"))
      .flatMap(row => row.evidenceRefs.filter(ref => ref.startsWith(META))));
    const candidates: CentralResearchEpisodeMetadata[] = selectedRef === base ? [{ ...draft, selection: "initial", previous: null }]
      : known.filter(row => row.issue.issueId !== selectedKnown.issue.issueId).flatMap(row => [...row.programRefs, null].flatMap(priorProgram => {
        const prior: Previous = { issueId: row.issue.issueId, grantId: row.grant?.grantId ?? null, requestRef: row.requestRef, programRef: priorProgram };
        return selectedRef !== `central-research-episode:${contentHashOf([base, prior.issueId, prior.grantId, program])}` ? []
          : [{ ...draft, selection: "derived_continuation" as const, previous: prior }];
      }));
    const recovered = candidates.filter(value => refs.has(centralResearchEpisodeMetadataMaterial(value).ref));
    if (recovered.length > 1 || refs.size > 0 && recovered.length === 0) return fail("central_research_episode_metadata_unconfirmed", [selectedKnown.issue.issueId, ...refs]);

    stored = recovered[0];
  }

  const metadata = centralResearchEpisodeMetadataMaterial(stored ?? draft);

  active();

  return { ...request, requestRef: selectedRef, materials: [metadata, ...request.materials.filter(row => !row.ref.startsWith(META))],
    sourceRefs: [...new Set([...metadata.sourceRefs, metadata.ref, ...request.sourceRefs.filter(ref => !PROGRAM.test(ref))])] };
}

/** Small source-owned context entries for the existing workflow opportunity
 * evidence field. These navigation refs neither count samples nor assess value.
 */
export function centralResearchEpisodeEvidence(request: GroundedCentralResearch): readonly { readonly ref: string; readonly summary: string }[] {
  const metadata = readCentralResearchEpisodeMetadata(request.materials);
  if (metadata === undefined) return [];

  const material = centralResearchEpisodeMetadataMaterial(metadata);

  return [...material.sourceRefs.map(ref => ({ ref, summary: ref === metadata.baseRequestRef
    ? "Original central learning purpose request; the same intent and root authorization remain in force."
    : ref === metadata.programRef ? "Public program/read-source deduplication marker; not value, a new observation or an independent sample."
      : "Actual predecessor native issue/grant; its expenditures, including unknown usage, remain owned by the original root." })),
  { ref: material.ref, summary: material.text }];
}
