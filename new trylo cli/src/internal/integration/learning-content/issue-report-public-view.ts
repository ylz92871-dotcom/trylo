import type { LearningIssue } from "../../learning/control/coordination-contract.js";
import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { CentralResearchIntakeError } from "../central-learning/research-intake-common.js";
import { readCentralResearchIssueRequestRef } from "../central-learning/research-intake-episode.js";
import { readCentralResearchEpisodeOrigin } from "../central-learning/research-intake-origin.js";
import { centralResearchEpisodeMetadataMaterial, readCentralResearchProgramReportMetadata } from "../central-learning/research-intake-episode-metadata.js";

/** The original immutable report remains authoritative and readable. Only its
 * authenticated host metadata has a structured public view; ordinary prose keeps the original policy. */
export function publicContentIssueReports(board: BoardState, issue: LearningIssue): readonly unknown[] {
  return issue.reports.map(report => {
    try {
      const metadata = readCentralResearchProgramReportMetadata(report);
      if (metadata === undefined) return report;

      const requestRef = readCentralResearchIssueRequestRef(board, issue, metadata.domain, metadata.intentRef);
      if (requestRef === undefined || requestRef !== metadata.requestRef) return report;

      const origin = readCentralResearchEpisodeOrigin(issue, requestRef);
      if (origin === undefined || origin.intentRef !== metadata.intentRef || origin.baseRequestRef !== metadata.baseRequestRef
        || report.facts.slice(1).map(part => part.slice("episode_metadata_part:".length)).join("") !== canonicalJson(metadata)) return report;

      const { scope: _scope, ...publicMetadata } = metadata;

      return { ...report, facts: [report.facts[0]], programReception: { ...publicMetadata,
        originalReportRef: report.reportId, metadataRef: centralResearchEpisodeMetadataMaterial(metadata).ref } };
    } catch (error) {
      // An unverified claim never receives the host projection. Its original
      // bytes still face the unchanged ordinary-prose privacy checks.
      if (error instanceof CentralResearchIntakeError) return report;
      throw error;
    }
  });
}
