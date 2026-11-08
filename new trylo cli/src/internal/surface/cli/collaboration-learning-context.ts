import type { SubagentTeam } from "../../subagent/team.js";
import type { LearningIssue } from "../../learning/control/coordination-contract.js";

/** A focused learner gets the concrete arrangement, not every full library configuration or unrelated use receipt. */
export function collaborationLearningContext(input: {
  readonly issue: LearningIssue; readonly team?: SubagentTeam; readonly owners: readonly unknown[];
  readonly dependencies: readonly unknown[]; readonly progress: readonly unknown[];
  readonly trialHistory?: unknown;
  readonly objective?: unknown;
}) {
  return { sourceTeam: input.team ? { runId: input.team.runId, profileId: input.team.profileId, surface: input.team.surface,
    configurationBasis: "frozen_team_profile",
    members: input.team.members.map(member => ({ memberId: member.memberId, baseRole: member.baseRole,
      responsibilities: member.role.description, instructions: member.role.prompt?.slice(0, 900),
      configuredTools: member.role.allowedTools, expert: member.expert })) } : undefined,
    owners: input.owners, dependencies: input.dependencies, progress: input.progress.slice(-6),
    ...(input.trialHistory === undefined ? {} : { trialHistory: input.trialHistory }),
    ...(input.objective === undefined ? {} : { objective: input.objective }),
    note: "sourceTeam is the frozen team baseline; owners retrievalContext reflects the last actual prepare when available, not a new grant or proof of exposure. Query the public libraries for relevant existing capabilities. Unknown conditions must remain unknown." };
}
