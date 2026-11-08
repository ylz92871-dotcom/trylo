import type { BoardState } from "../../learning/control/state.js";
import type { CentralLearningGrant, LearningIssue, LearningIssueReport } from "../../learning/control/coordination-contract.js";
import { readCentralPursuitObservations } from "../learning-allocation/pursuit-observations.js";
import { readFrozenStage, type FrozenCentralStage } from "./stage-evidence.js";
import { CENTRAL_RESEARCH_PROGRAM, readCentralResearchProgramReportMetadata } from "./research-intake-episode-metadata.js";
import { CentralResearchIntakeError } from "./research-intake-common.js";

interface Source { readonly issue: LearningIssue; readonly grant: CentralLearningGrant | undefined }

export interface CentralResearchProgramAssignment { readonly programRef: string;
  readonly outcome: "pending" | "qualified" | "closed_no_result"; readonly sourceRefs: readonly string[];
  readonly sequence: number; readonly frozen: FrozenCentralStage }

const fail = (refs: readonly string[]): never => { throw new CentralResearchIntakeError("central_research_episode_assignment_inspection_required", refs); };

/** Read the original committed assignment and its frozen native source report.
 * Reception alone never consumes a program. Pending/unknown actual assignments
 * hold their original identity without claiming that a model or learning succeeded.
 */
export async function readCentralResearchAssignedPrograms(options: { readonly boardRoot: string; readonly scope: string;
  readonly board: BoardState; readonly sources: readonly Source[];
  readonly legacyProgramForReport: (source: Source, report: LearningIssueReport) => string | undefined | Promise<string | undefined> }, signal: AbortSignal): Promise<ReadonlyMap<string, readonly CentralResearchProgramAssignment[]>> {
  const observed = readCentralPursuitObservations(options.board, options.scope);
  if (observed.status !== "ready") throw new CentralResearchIntakeError(observed.reason, []);

  const result = new Map<string, readonly CentralResearchProgramAssignment[]>();

  for (const source of options.sources) {
    const grant = source.grant;
    if (grant === undefined) {
      result.set(source.issue.issueId, []);
      continue;
    }

    const stages = observed.observations.filter(row => row.grantId === grant.grantId);
    if (stages.length === 0 && grant.reservations.length > 0) return fail([source.issue.issueId, grant.grantId]);

    const programs: CentralResearchProgramAssignment[] = [];

    for (const stage of stages) {
      if (signal.aborted) throw new CentralResearchIntakeError("central_research_episode_inactive", [source.issue.issueId]);

      const frozen = await readFrozenStage({ boardRoot: options.boardRoot, scope: options.scope, grantId: grant.grantId, stageRef: stage.stageRef });
      if (frozen.status !== "ready" || frozen.value.input.issueId !== source.issue.issueId
        || frozen.value.input.grantId !== grant.grantId) return fail([source.issue.issueId, grant.grantId, stage.stageRef]);

      const report = source.issue.reports.find(row => row.reportId === frozen.value.candidate.source.domainStage.sourceReportId);
      if (report === undefined) return fail([source.issue.issueId, stage.stageRef]);

      const metadata = readCentralResearchProgramReportMetadata(report);
      const markers = [...new Set(report.evidenceRefs.filter(ref => CENTRAL_RESEARCH_PROGRAM.test(ref)))];
      const legacy = metadata === undefined && markers.length === 0 ? await options.legacyProgramForReport(source, report) : undefined;
      const programRef = metadata?.programRef ?? (markers.length === 1 ? markers[0] : legacy);
      if (programRef === undefined) return fail([source.issue.issueId, grant.grantId, stage.stageRef]);

      programs.push({ programRef, outcome: stage.outcome, sourceRefs: [source.issue.issueId, grant.grantId,
        stage.stageRef, frozen.value.unitId, report.reportId, frozen.value.input.sourceBindingRef], sequence: stage.sequence, frozen: frozen.value });
    }

    result.set(source.issue.issueId, programs);
  }

  return result;
}
