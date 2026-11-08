import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { CentralFundedStage } from "../../../../../integration/central-learning/contracts.js";
import { readCentralMethodResearchCandidates } from "./central-research-candidate.js";
import { methodResearchGrantId, methodResearchIssueId, readMethodResearch } from "./central-research-records.js";

export interface CentralMethodResearchStageProduction {
  readonly publishedVersionRefs: readonly string[];
  readonly checkpointRefs: readonly string[];
  readonly reservationRefs: readonly string[];
  readonly sourceRefs: readonly string[];
}

type ProductionScope = { readonly scope: string; readonly workspaceId?: string };

type RequestProduction = { readonly history: ReturnType<typeof readMethodResearch>;
  readonly candidates: ReturnType<typeof readCentralMethodResearchCandidates> };

/** One immutable loaded Board prefix per batch. A new Board needs a new reader;
 * request decoding is retained only inside this explicit caller-owned session. */
export function createCentralMethodResearchProductionReader(board: BoardState, { scope, workspaceId }: ProductionScope) {
  const requests = new Map<string, RequestProduction>();
  const readRequest = (requestRef: string): RequestProduction => {
    const known = requests.get(requestRef);
    if (known !== undefined) return known;
    const history = readMethodResearch(board, scope, requestRef);
    const result = { history, candidates: history === undefined ? [] : readCentralMethodResearchCandidates(board, scope, requestRef, workspaceId) };
    requests.set(requestRef, result);
    return result;
  };

  return (input: CentralFundedStage) => stageProduction(board, scope, input, readRequest);
}

/** Historical publication proof, independent of the original owner's later
 * job status, billing certainty or the candidate's current availability. */
export function readCentralMethodResearchStageProduction(board: BoardState,
  { input, ...selection }: ProductionScope & { readonly input: CentralFundedStage }): CentralMethodResearchStageProduction | undefined {
  return createCentralMethodResearchProductionReader(board, selection)(input);
}

function stageProduction(board: BoardState, scope: string, input: CentralFundedStage,
  readRequest: (requestRef: string) => RequestProduction): CentralMethodResearchStageProduction | undefined {
  const issue = board.learningIssues?.find(row => row.scope === scope && row.issueId === input.issueId);
  const source = issue?.reports[0]?.source;
  if (issue === undefined || source === undefined || !("kind" in source) || source.kind !== "research_request" || source.domain !== "prompt"
    || issue.issueId !== methodResearchIssueId(source.requestRef) || input.grantId !== methodResearchGrantId(source.requestRef)
    || issue.reports.some(row => !("kind" in row.source) || row.source.kind !== "research_request" || row.source.domain !== "prompt"
      || row.source.requestRef !== source.requestRef || row.source.intentRef !== source.intentRef)) return undefined;

  const { history, candidates } = readRequest(source.requestRef);

  if (history === undefined || history.request.intentRef !== source.intentRef || history.request.intent.subject.plane !== "central"
    || history.request.intent.subject.questionRef !== source.intentRef) return undefined;

  const grant = board.centralLearningGrants?.find(row => row.grantId === input.grantId);
  const job = board.jobs.find(row => row.jobId === grant?.jobId);
  if (grant === undefined || job === undefined || grant.scope !== scope || grant.domain !== "prompt" || grant.issueId !== issue.issueId
    || issue.grantId !== grant.grantId || issue.jobId !== grant.jobId || job.scope !== scope || job.domain !== "prompt"
    || job.coordination?.issueId !== issue.issueId || job.coordination.grantId !== grant.grantId
    || grant.budgetId === undefined || grant.authorizationRef === undefined || grant.planRef === undefined
    || input.expectedIssueRevision < grant.focusRevision || input.expectedIssueRevision > issue.revision
    || input.offer.owner.plane !== "agent" || input.offer.owner.domain !== "prompt") return undefined;

  const inputHash = contentHashOf(input);
  const checkpoints = history.steps.filter(row => row.step.stageInputHash === inputHash && row.step.finding.kind === "candidate"
    && grant.reservations.some(reservation => reservation.reservationId === row.step.reservationId && reservation.state === "settled"));
  const published = candidates.filter(candidate => checkpoints.some(row =>
    row.ref === candidate.checkpointRef && row.step.reservationId === candidate.reservationId));
  if (published.length === 0) return undefined;

  const checkpointRefs = [...new Set(published.map(row => row.checkpointRef))];
  const reservationRefs = [...new Set(published.map(row => row.reservationId))];

  return { publishedVersionRefs: [...new Set(published.map(row => row.versionId))], checkpointRefs, reservationRefs,
    sourceRefs: [...new Set([issue.issueId, grant.grantId, job.jobId, source.requestRef, source.intentRef, history.requestId,
      input.stageRef, input.sourceBindingRef, ...checkpointRefs, ...reservationRefs, ...published.flatMap(row => row.sourceRefs)])] };
}
