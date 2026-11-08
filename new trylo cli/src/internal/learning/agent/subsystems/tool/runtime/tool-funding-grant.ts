import type { BoardState } from "../../../../control/state.js";
import type { CentralLearningGrant } from "../../../../control/coordination-contract.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";

/** Tool plans retain their workspace ID while central funds use the issue's
 * workspace root. Resolve that scope through the Board's canonical issue/job
 * binding, including legacy issues, rather than equating the two namespaces. */
export function toolFundingGrantMatches(state: BoardState, plan: ToolLearningPlan, grant: CentralLearningGrant): boolean {
  const identity = toolLearningFundingIdentity(plan);
  const issue = state.learningIssues?.find(row => row.issueId === identity.issueId);
  const job = state.jobs.find(row => row.jobId === grant.jobId);
  return grant.domain === "tool" && grant.grantId === identity.grantId && grant.issueId === identity.issueId
    && issue !== undefined && grant.scope === issue.scope && job?.domain === "tool" && job.scope === issue.scope
    && job.coordination?.grantId === grant.grantId && job.coordination.issueId === identity.issueId;
}
