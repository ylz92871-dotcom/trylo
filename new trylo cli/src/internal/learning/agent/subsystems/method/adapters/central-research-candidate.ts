import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { shortId } from "../../../../domains/shared/hash.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import { scanForbiddenText } from "../../../../domains/shared/forbidden-scan.js";
import { cardLengthOf, MAX_CARD_CHARS, type MethodCard } from "../domain/contracts.js";
import { nicheOf } from "../domain/niche.js";
import { isCentralResearchMethodOrigin } from "../domain/research-origin.js";
import { ADMISSION_PROVENANCE, isMethodCardContent } from "../assets/archive.js";
import { createMethodBoardWriter, variantsOf } from "./board-writer.js";
import { experienceViewOf } from "./experience-store.js";
import { usableScopes } from "../orchestration/experience-selection.js";
import { METHOD_ASSET_KIND, METHOD_DOMAIN, METHOD_EVIDENCE_KIND } from "./method-commit.js";
import { isMethodResearchFinding, methodResearchGrantId, methodResearchIssueId, readMethodResearch,
  type MethodResearchFinding, type MethodResearchRequest } from "./central-research-records.js";

type Options = { readonly boardRoot: string; readonly scope: string; readonly workspaceId: string;
  readonly now: () => number; readonly enabled: () => boolean };

type Input = { readonly request: MethodResearchRequest; readonly finding: MethodResearchFinding;
  readonly reservationId: string; readonly checkpointRef: string };

export type CentralMethodResearchCandidate = { readonly versionId: string; readonly scopeId: string;
  readonly checkpointRef: string; readonly reservationId: string; readonly sourceRefs: readonly string[];
  readonly availability: "available" | "withdrawn" };

function publicationIdentity(versionId: string) {
  const scopeId = "research-source";
  return { scopeId, proposalId: shortId("method-research-proposal", [versionId]),
    evidenceId: shortId("method-research-admission", [versionId]),
    scopeFactId: shortId("method-research-scope", [versionId, scopeId]),
    hypothesisId: shortId("method-research-hypothesis", [versionId, scopeId]) };
}

function researchVersionId(workspaceId: string, requestRef: string, checkpointRef: string,
  candidate: NonNullable<MethodResearchFinding["candidate"]>): string {
  return shortId("method-research", [workspaceId, requestRef, checkpointRef, canonicalJson(candidate)]);
}

function researchCard(input: Input): MethodCard {
  if (input.finding.kind !== "candidate" || input.finding.candidate === undefined) throw new Error("method_research_candidate_required");
  return { schemaVersion: 1, hint: input.finding.candidate.hint, appliesWhen: {}, labels: [],
    lineage: { createdFrom: { kind: "central_research", requestRef: input.request.requestRef,
      checkpointRef: input.checkpointRef, reservationId: input.reservationId } } };
}

function withdrawn(state: BoardState, versionId: string): boolean {
  const asset = state.assets.find(item => item.versionId === versionId);
  const proposal = state.proposals.find(item => item.proposalId === asset?.createdFromProposalId);
  const variant = variantsOf(state).find(item => item.versionId === versionId);

  return asset === undefined || proposal === undefined || ["rejected", "retired", "suspended", "rolled_back"].includes(proposal.lifecycle)
    || state.tombstones.some(item => item.entityId === versionId || item.entityId === proposal.proposalId)
    || variant?.retention === "evicted" || variant?.ledger.state === "archived"
    || state.methodExperienceFacts?.some(fact => fact.kind === "exit" && fact.versionId === versionId && fact.mode === "archive") === true;
}

function originalCandidate(state: BoardState, scope: string, input: Input) {
  const history = readMethodResearch(state, scope, input.request.requestRef);
  const step = history?.steps.find(item => item.ref === input.checkpointRef);
  if (history === undefined || canonicalJson(history.request) !== canonicalJson(input.request)
    || step?.step.reservationId !== input.reservationId || canonicalJson(step.step.finding) !== canonicalJson(input.finding)
    || !isMethodResearchFinding(input.finding) || input.finding.kind !== "candidate" || input.finding.candidate === undefined) {
    throw new Error("method_research_candidate_original_checkpoint_required");
  }

  const grant = state.centralLearningGrants?.find(item => item.scope === scope && item.domain === "prompt"
    && item.grantId === methodResearchGrantId(input.request.requestRef) && item.issueId === methodResearchIssueId(input.request.requestRef)
    && item.reservations.some(reservation => reservation.reservationId === input.reservationId && reservation.state === "settled"));
  if (grant?.budgetId === undefined || !state.learningIssues?.some(issue => issue.issueId === grant.issueId
    && issue.decision.kind === "focused_learning" && issue.reports.some(report => "kind" in report.source
      && report.source.kind === "research_request" && report.source.domain === "prompt"
      && report.source.requestRef === input.request.requestRef && report.source.intentRef === input.request.intentRef))) {
    throw new Error("method_research_candidate_original_funding_required");
  }

  return input.finding.candidate;
}

/** Publish a source hypothesis through the original card writer. Its lineage is
 * the paid research checkpoint; no task, failure beat, outcome or A/M is invented. */
export async function publishCentralMethodResearchCandidate(options: Options, input: Input, signal: AbortSignal): Promise<CentralMethodResearchCandidate> {
  const active = () => options.enabled() && !signal.aborted;
  if (!active()) throw new Error("method_research_candidate_inactive");

  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) throw new Error(loaded.reason);

  const candidate = originalCandidate(loaded.state, options.scope, input);
  const previous = readCentralMethodResearchCandidates(loaded.state, options.scope, input.request.requestRef, options.workspaceId)
    .find(item => item.checkpointRef === input.checkpointRef && item.reservationId === input.reservationId);
  if (previous !== undefined) {
    if (previous.availability === "withdrawn") throw new Error("method_research_candidate_withdrawn");
    return previous;
  }

  // Scan the published card/scope payload. Research conditions remain original
  // provenance, and may explicitly say that a method cannot change permissions.
  // They are not installed instructions or a source of execution authority.
  if (scanForbiddenText([candidate.hint, candidate.scope.description]).length > 0) {
    throw new Error("method_research_candidate_forbidden_content");
  }

  const versionId = researchVersionId(options.workspaceId, input.request.requestRef, input.checkpointRef, candidate);
  const { scopeId, proposalId, evidenceId, scopeFactId, hypothesisId } = publicationIdentity(versionId);
  const card = researchCard(input);
  if (cardLengthOf(card) > MAX_CARD_CHARS) throw new Error("method_research_candidate_card_capacity");

  const writer = createMethodBoardWriter(options.boardRoot, { commandGuard: active });

  if (!active()) throw new Error("method_research_candidate_inactive");

  const committed = await writer.commitCard({ card, nicheId: nicheOf(card), versionId,
    proposalId, evidenceId,
    writeId: versionId, sample: `research-inference:${input.checkpointRef}`, observedAt: new Date(options.now()).toISOString() });
  if (!committed.ok) throw new Error(`method_research_candidate_commit:${committed.reason}`);

  const scoped = await withBoardWriter(options.boardRoot, async store => {
    const current = await store.load();
    if (!current.ok) return current;

    originalCandidate(current.state, options.scope, input);

    if (withdrawn(current.state, versionId)) throw new Error("method_research_candidate_withdrawn");

    const existing = current.state.methodExperienceFacts?.find(fact => fact.factId === scopeFactId);
    if (existing !== undefined) {
      if (existing.kind !== "scope" || existing.versionId !== versionId || existing.description !== candidate.scope.description
        || canonicalJson(existing.hypothesis.predicate) !== canonicalJson(candidate.scope.predicate)) throw new Error("method_research_candidate_scope_conflict");
      return { ok: true as const };
    }

    return store.apply({ type: "record_method_experience", commandId: scopeFactId, issuedAt: new Date(options.now()).toISOString(),
      fact: { kind: "scope", factId: scopeFactId, versionId, sequence: current.state.sequence + 1, description: candidate.scope.description,
        hypothesis: { id: hypothesisId, versionId, scopeId,
          proposedSequence: current.state.sequence, predicate: candidate.scope.predicate } } });
  }, { commandGuard: active });
  if (!scoped.ok) throw new Error(`method_research_candidate_scope:${scoped.reason}`);

  return { versionId, scopeId, checkpointRef: input.checkpointRef, reservationId: input.reservationId, availability: "available",
    sourceRefs: [...new Set([versionId, proposalId, evidenceId, scopeFactId, input.checkpointRef, input.request.requestRef, ...input.finding.sourceRefs])] };
}

/** Only complete native card+scope pairs are delivered candidates. A crash
 * after commitCard leaves a source-only asset without inventing a match scope. */
export function readCentralMethodResearchCandidates(state: BoardState, scope: string, requestRef: string,
  workspaceId?: string): readonly CentralMethodResearchCandidate[] {
  const history = readMethodResearch(state, scope, requestRef);
  if (history === undefined) return [];

  const available = usableScopes(experienceViewOf(state));

  return state.assets.flatMap(asset => {
    if (!isMethodCardContent(asset.content)) return [];

    const origin = asset.content.lineage.createdFrom;
    if (!isCentralResearchMethodOrigin(origin) || origin.requestRef !== requestRef) return [];

    const step = history.steps.find(item => item.ref === origin.checkpointRef && item.step.reservationId === origin.reservationId);
    if (step?.step.finding.kind !== "candidate" || step.step.finding.candidate === undefined) return [];

    if (workspaceId !== undefined && asset.versionId !== researchVersionId(workspaceId, requestRef, step.ref, step.step.finding.candidate)) return [];

    const expected = researchCard({ request: history.request, finding: step.step.finding,
      checkpointRef: step.ref, reservationId: step.step.reservationId });
    const ids = publicationIdentity(asset.versionId), nicheId = nicheOf(expected);
    const proposal = state.proposals.find(item => item.proposalId === ids.proposalId);
    const admission = state.evidence.find(item => item.evidenceId === ids.evidenceId);
    if (asset.kind !== METHOD_ASSET_KIND || asset.scope !== nicheId || asset.schemaVersion !== expected.schemaVersion
      || asset.createdFromProposalId !== ids.proposalId || asset.contentHash !== contentHashOf(expected)
      || canonicalJson(asset.content) !== canonicalJson(expected) || proposal?.domain !== METHOD_DOMAIN
      || proposal.scope !== nicheId || proposal.assetKind !== METHOD_ASSET_KIND || proposal.candidateRef !== asset.versionId
      || admission?.proposalId !== ids.proposalId || admission.provenance !== ADMISSION_PROVENANCE
      || canonicalJson(admission.kinds) !== canonicalJson([METHOD_EVIDENCE_KIND]) || admission.dataVersion !== String(expected.schemaVersion)
      || canonicalJson(admission.failureSamples) !== canonicalJson([`research-inference:${step.ref}`])) return [];

    const registered = state.methodExperienceFacts?.find(fact => fact.kind === "scope" && fact.factId === ids.scopeFactId
      && fact.versionId === asset.versionId && fact.description === step.step.finding.candidate?.scope.description
      && fact.hypothesis.id === ids.hypothesisId && fact.hypothesis.versionId === asset.versionId
      && fact.hypothesis.scopeId === ids.scopeId && canonicalJson(fact.hypothesis.predicate) === canonicalJson(step.step.finding.candidate?.scope.predicate));

    return registered?.kind !== "scope" ? [] : [{ versionId: asset.versionId, scopeId: registered.hypothesis.scopeId,
      checkpointRef: origin.checkpointRef, reservationId: origin.reservationId,
      availability: !withdrawn(state, asset.versionId) && available.some(item => item.versionId === asset.versionId
        && item.hypothesis.scopeId === registered.hypothesis.scopeId) ? "available" as const : "withdrawn" as const,
      sourceRefs: [...new Set([asset.versionId, ids.proposalId, ids.evidenceId, registered.factId,
        origin.checkpointRef, requestRef, ...step.step.finding.sourceRefs])] }];
  });
}
