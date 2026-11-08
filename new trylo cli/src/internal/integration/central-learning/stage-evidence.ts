import path from "node:path";
import { mkdir, open } from "node:fs/promises";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { fields, identity, list, sequence } from "../../validation/json-shape.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";
import { isCentralPursuitObjective } from "../../learning/control/decision/pursuit-validation.js";
import { isCentralResponseOpportunity } from "../../learning/control/decision/prediction-validation.js";
import { isCentralDecisionStageSource } from "../../learning/control/decision/stage-projection.js";
import { isCentralTimingInput } from "../../learning/control/decision/timing-model.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { readCentralPursuitObservations } from "../learning-allocation/pursuit-observations.js";
import { centralPursuitTreatmentRef } from "../../learning/control/decision/pursuit-resource-model.js";
import { inspectCentralFundedStage, isCentralFundedStage } from "./funded-stage.js";
import type { CentralFundedStage, CentralLearningExecutionPort, CentralStageObservation } from "./contracts.js";
import { centralStageUnitId } from "./stage-unit.js";
import { buildPreLearningSourceSnapshot, isPreLearningSourceSnapshot, readPreLearningSourceSnapshot,
  type PreLearningSourceSnapshot } from "../learning-content/index.js";

const MAX_ARCHIVE_BYTES = 131072; // Same bounded opaque payload envelope as RewardV2.

type Address = { readonly boardRoot: string; readonly scope: string; readonly grantId: string; readonly stageRef: string };

type FrameBase = { readonly type: "central_stage_evidence";
  readonly unitId: string; readonly scope: string; readonly budgetId: string; readonly committedAtSequence: number;
  readonly sourceReportHash: string; readonly input: CentralFundedStage; readonly candidate: CentralPursuitCandidate };

type FramePayload = FrameBase & ({ readonly schemaVersion: 1 }
  | { readonly schemaVersion: 2; readonly sourceSnapshot: PreLearningSourceSnapshot });

export type FrozenCentralStage = FramePayload & { readonly digest: string };

type Unknown = { readonly status: "unknown"; readonly reason: string };

const unknown = (reason: string): Unknown => ({ status: "unknown", reason });
const stageKey = (grantId: string, stageRef: string) => contentHashOf([grantId, stageRef]);
const archiveFile = (address: Address) => path.join(address.boardRoot, "central-decisions", "stage-evidence",
  `${stageKey(address.grantId, address.stageRef)}.json`);

/** A resumed decision reads a new clock for the same physical assignment. Only
 * this observation time is excluded: handoff boundaries, fees, target, source,
 * objective, offer and execution CAS remain part of exact assignment equality. */
function assignmentWithoutReadinessClock(candidate: CentralPursuitCandidate) {
  if (candidate.readiness.kind !== "ready" && candidate.readiness.kind !== "handoff") return candidate;
  const { now: _now, ...readiness } = candidate.readiness;
  return { ...candidate, readiness };
}

function sameFrozenAssignment(frame: FrozenCentralStage, input: CentralFundedStage, candidate: CentralPursuitCandidate): boolean {
  return canonicalJson(frame.input) === canonicalJson(input)
    && canonicalJson(assignmentWithoutReadinessClock(frame.candidate)) === canonicalJson(assignmentWithoutReadinessClock(candidate));
}

function candidateShape(value: unknown, context: { readonly scope: string; readonly budgetId: string; readonly committedAtSequence: number }):
  value is CentralPursuitCandidate {
  if (!fields(value, ["opportunity", "source", "readiness", "target", "fee", "purpose", "objective"])
    || !isCentralResponseOpportunity(value.opportunity) || !isCentralDecisionStageSource(value.source)
    || !isCentralPursuitObjective(value.objective) || value.objective.criterion !== "proposal_delivered"
    || (value.purpose !== "focused_learning" && value.purpose !== "required_preparation")) return false;

  const opportunity = value.opportunity;

  return opportunity.scope === context.scope && opportunity.instanceRef === value.source.domainStage.stageRef
    && opportunity.stage === value.source.domainStage.kind && opportunity.sourceRef === value.source.sourceBindingRef
    && opportunity.offer.policyRef === value.source.domainStage.policyRef
    // Reuse the complete timing DTO guard without predicting any outcome.
    && isCentralTimingInput({ schemaVersion: 1, opportunityId: opportunity.opportunityId, windowRef: opportunity.windowRef,
      forecastRef: value.objective.familySourceRef, mean: 0, offer: opportunity.offer,
      basis: { scope: context.scope, budgetId: context.budgetId, boardSequence: context.committedAtSequence,
        utilityUnit: "qualified_objective_completions", valuationRef: value.source.sourceBindingRef },
      readiness: value.readiness, target: value.target, fee: value.fee });
}

function isFrozenStage(value: unknown): value is FrozenCentralStage {
  const common = ["schemaVersion", "type", "unitId", "scope", "budgetId", "committedAtSequence", "sourceReportHash", "input", "candidate", "digest"];
  if (!(fields(value, common) && value.schemaVersion === 1
      || fields(value, [...common, "sourceSnapshot"]) && value.schemaVersion === 2 && isPreLearningSourceSnapshot(value.sourceSnapshot))
    || value.type !== "central_stage_evidence"
    || ![value.unitId, value.scope, value.budgetId, value.sourceReportHash, value.digest].every(identity)
    || !sequence(value.committedAtSequence) || value.committedAtSequence < 1 || !isCentralFundedStage(value.input)
    || value.input.expectedIssueRevision < 1
    || !identity(value.scope) || !identity(value.budgetId)
    || !candidateShape(value.candidate, { scope: value.scope, budgetId: value.budgetId, committedAtSequence: value.committedAtSequence })) return false;

  const { input, candidate, digest, ...rest } = value;

  if (input.offer.owner.plane !== "agent") return false;

  if (value.schemaVersion === 2) {
    const snapshot = value.sourceSnapshot;
    if (!isPreLearningSourceSnapshot(snapshot) || snapshot.scope !== value.scope || snapshot.issueId !== input.issueId
      || snapshot.domain !== input.offer.owner.domain || snapshot.knownAtBoardSequence > value.committedAtSequence) return false;
    const report = snapshot.originalReports.selected.find(row => row.reportId === candidate.source.domainStage.sourceReportId);
    if (report === undefined ? snapshot.originalReports.omitted === 0 : report.reportHash !== value.sourceReportHash) return false;
  }

  return candidate.source.issueId === input.issueId
    && candidate.source.grantId === input.grantId && candidate.source.domainStage.stageRef === input.stageRef
    && candidate.source.domainStage.policyRef === input.policyRef && candidate.source.sourceBindingRef === input.sourceBindingRef
    && contentHashOf(candidate.opportunity.offer) === contentHashOf(input.offer)
    && value.unitId === centralStageUnitId(input.grantId, input.stageRef)
    && digest === contentHashOf({ ...rest, input, candidate });
}

/** Historical binding deliberately allows later revisions, rebudgeting and
 * closed grants. They do not erase the original delivered-stage question. */
function historicallyBound(board: BoardState, frame: FrozenCentralStage): boolean {
  const issue = board.learningIssues?.find(row => row.issueId === frame.input.issueId && row.scope === frame.scope);
  const grant = board.centralLearningGrants?.find(row => row.grantId === frame.input.grantId);
  const job = board.jobs.find(row => row.jobId === grant?.jobId);
  const report = issue?.reports.find(row => row.reportId === frame.candidate.source.domainStage.sourceReportId);
  const owner = issue === undefined || report === undefined ? undefined : learningIssueOwner({ ...issue, reports: [report] });
  const offerOwner = frame.input.offer.owner;

  return offerOwner.plane === "agent" && frame.committedAtSequence <= board.sequence
    && issue !== undefined && issue.revision >= frame.input.expectedIssueRevision
    && (owner === "method" ? "prompt" : owner) === offerOwner.domain
    && report !== undefined && contentHashOf(report) === frame.sourceReportHash
    && grant !== undefined && grant.issueId === issue.issueId && grant.scope === frame.scope
    && grant.budgetId === frame.budgetId && grant.authorizationRef !== undefined && grant.planRef !== undefined
    && (grant.domain ?? "collaboration") === offerOwner.domain && grant.focusRevision <= frame.input.expectedIssueRevision
    && (frame.schemaVersion === 1 || frame.sourceSnapshot.originalFocus.decisionRevision === grant.focusRevision)
    && job !== undefined && job.scope === frame.scope && job.domain === offerOwner.domain
    && job.coordination?.issueId === issue.issueId && job.coordination.grantId === grant.grantId
    && board.centralLearningBudgets?.some(row => row.budgetId === frame.budgetId && row.scope === frame.scope) === true;
}

async function readArchive(address: Address): Promise<{ readonly status: "ready"; readonly value: FrozenCentralStage } | Unknown> {
  if (![address.scope, address.grantId, address.stageRef].every(identity)) return unknown("central_stage_archive_address_invalid");

  let handle;

  try { handle = await open(archiveFile(address), "r"); }
  catch (error) {
    return unknown(error instanceof Error && "code" in error && error.code === "ENOENT"
      ? "central_stage_archive_missing" : "central_stage_archive_read_failed");
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) return unknown("central_stage_archive_capacity");

    const payload = await handle.readFile("utf8");
    if (Buffer.byteLength(payload, "utf8") > MAX_ARCHIVE_BYTES) return unknown("central_stage_archive_capacity");

    let raw: unknown;

    try { raw = JSON.parse(payload); } catch { return unknown("central_stage_archive_json"); }

    if (!isFrozenStage(raw) || canonicalJson(raw) !== payload || raw.scope !== address.scope
      || raw.input.grantId !== address.grantId || raw.input.stageRef !== address.stageRef) return unknown("central_stage_archive_binding");

    if (raw.schemaVersion === 1) return { status: "ready", value: raw };

    const snapshot = readPreLearningSourceSnapshot(raw.sourceSnapshot);

    return snapshot.ok ? { status: "ready", value: { ...raw, sourceSnapshot: snapshot.value } }
      : unknown(snapshot.reason);
  } catch { return unknown("central_stage_archive_read_failed"); }
  finally { await handle.close(); }
}

/** Freeze only after the original commit and before dispatch. This immutable
 * file is evidence, never a grant, pending-work index or execution capability. */
export async function retainFrozenStage(options: { readonly boardRoot: string; readonly candidate: CentralPursuitCandidate;
  readonly input: CentralFundedStage }) {
  const { candidate, input } = options;

  if (!isCentralFundedStage(input) || input.offer.owner.plane !== "agent") return unknown("central_stage_archive_input_invalid");

  const scope = candidate?.opportunity?.scope;
  if (!identity(scope)) return unknown("central_stage_archive_candidate_invalid");

  const address = { boardRoot: options.boardRoot, scope, grantId: input.grantId, stageRef: input.stageRef }, file = archiveFile(address);
  // A retry reuses the original source prefix. It never samples today's source
  // or upgrades a legacy frame in place, even after a later report or grant.
  const previous = await readArchive(address);
  if (previous.status === "ready") {
    if (!candidateShape(candidate, previous.value)) return unknown("central_stage_archive_candidate_invalid");
    const bound = await readFrozenStage(address);
    return bound.status === "ready" && sameFrozenAssignment(bound.value, input, candidate)
      ? { status: "retained" as const, value: bound.value, file } : unknown("central_stage_archive_conflict");
  }

  if (previous.reason !== "central_stage_archive_missing") return previous;

  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return unknown(loaded.reason);

  const selected = inspectCentralFundedStage(loaded.state, { scope, domain: input.offer.owner.domain, input });
  if (!selected.ok) return unknown(selected.reason);

  const report = selected.issue.reports.find(row => row.reportId === candidate.source?.domainStage?.sourceReportId);
  const budgetId = selected.grant.budgetId;
  if (report === undefined || budgetId === undefined) return unknown("central_stage_archive_source_missing");

  if (!candidateShape(candidate, { scope, budgetId, committedAtSequence: loaded.state.sequence })) return unknown("central_stage_archive_candidate_invalid");

  const sourceSnapshot = buildPreLearningSourceSnapshot({ board: loaded.state, scope, issueId: input.issueId, domain: input.offer.owner.domain });
  if (!sourceSnapshot.ok) return unknown(sourceSnapshot.reason);

  const payload: FramePayload = { schemaVersion: 2, type: "central_stage_evidence", unitId: centralStageUnitId(input.grantId, input.stageRef),
    scope, budgetId, committedAtSequence: loaded.state.sequence, sourceReportHash: contentHashOf(report), input, candidate,
    sourceSnapshot: sourceSnapshot.value };
  const frame = { ...payload, digest: contentHashOf(payload) };
  if (!isFrozenStage(frame) || !historicallyBound(loaded.state, frame)) return unknown("central_stage_archive_candidate_invalid");

  const text = canonicalJson(frame);
  if (Buffer.byteLength(text, "utf8") > MAX_ARCHIVE_BYTES) return unknown("central_stage_archive_capacity");

  await mkdir(path.dirname(file), { recursive: true });
  let handle;

  try { handle = await open(file, "wx"); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const previous = await readFrozenStage(address);
    return previous.status === "ready" && sameFrozenAssignment(previous.value, input, candidate)
      ? { status: "retained" as const, value: previous.value, file } : unknown("central_stage_archive_conflict");
  }

  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  }
  finally { await handle.close(); }

  return { status: "retained" as const, value: frame, file };
}

export async function readFrozenStage(address: Address) {
  const archived = await readArchive(address);
  if (archived.status !== "ready") return archived;
  const loaded = await createBoardReader(address.boardRoot).load();
  if (!loaded.ok) return unknown(loaded.reason);
  return historicallyBound(loaded.state, archived.value) ? archived : unknown("central_stage_archive_original_source_changed");
}

function observationShape(value: unknown): value is CentralStageObservation {
  return fields(value, ["outcome", "resultRefs", "sourceRefs", "reason"])
    && (value.outcome === "qualified" || value.outcome === "closed_no_result" || value.outcome === "pending") && identity(value.reason)
    && list(value.resultRefs, 0, 512) && value.resultRefs.every(identity)
    && (value.outcome !== "qualified" || value.resultRefs.length > 0)
    && list(value.sourceRefs, 0, 512) && value.sourceRefs.every(identity);
}

/** Only incomplete original heads may be refreshed by ordinary observation.
 * A later poor task outcome or unavailable artifact cannot undo delivery. The
 * caller must append through the original observation writer with expectedHeadRef. */
export async function refreshFrozenStageObservation(options: Address & {
  readonly port: Pick<CentralLearningExecutionPort, "domain" | "observe">;
}, signal: AbortSignal) {
  if (signal.aborted) return unknown("learning_observation_cancelled");

  const frozen = await readFrozenStage(options);
  if (frozen.status !== "ready") return frozen;

  const frame = frozen.value;
  if (frame.input.offer.owner.plane !== "agent" || options.port.domain !== frame.input.offer.owner.domain) return unknown("central_stage_archive_observer_mismatch");

  const readHead = async () => {
    const loaded = await createBoardReader(options.boardRoot).load();
    if (!loaded.ok) return unknown(loaded.reason);

    const history = readCentralPursuitObservations(loaded.state, options.scope);
    if (history.status !== "ready") return unknown(history.reason);

    const head = history.observations.find(row => row.unitId === frame.unitId);
    const pointer = history.heads.find(row => row.unitId === frame.unitId);
    if (head === undefined || pointer === undefined || head.grantId !== frame.input.grantId || head.stageRef !== frame.input.stageRef
      || head.conditionRef !== frame.candidate.opportunity.conditionRef || canonicalJson(head.objective) !== canonicalJson(frame.candidate.objective)
      || head.treatmentRef !== (frame.candidate.objective.resourceModel === undefined ? undefined : centralPursuitTreatmentRef(frame.input.offer))) {
      return unknown("central_stage_archive_observation_binding");
    }

    return { status: "ready" as const, head, factId: pointer.factId };
  };
  const prior = await readHead();
  if (prior.status !== "ready") return prior;

  if (prior.head.outcome !== "pending") return { status: "unchanged" as const, outcome: prior.head.outcome, expectedHeadRef: prior.factId };

  const observed = await options.port.observe(frame.input, signal);

  if (signal.aborted) return unknown("learning_observation_cancelled");

  if (!observationShape(observed)) return unknown("central_stage_archive_observer_invalid");

  const current = await readHead();
  if (current.status !== "ready" || current.factId !== prior.factId || current.head.outcome !== "pending") return unknown("central_stage_observation_head_changed");

  return { status: "refreshed" as const, frozen: frame, observed, expectedHeadRef: prior.factId };
}
