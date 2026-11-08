import type { JsonObject } from "../../../../../protocol/envelope.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import { isTeamLearningIssueReport, type LearningIssue } from "../../../../control/coordination-contract.js";

export type CollaborationSourceCondition = { readonly ref: string; readonly sourceRef: string; readonly features: JsonObject };

/** Already frozen host configuration. Names/identities locate its source only;
 * the reusable class contains the actual role and tool-policy structure. */
export type CollaborationConditionHost = {
  readonly sourceRef: string;
  readonly surface: "code" | "work";
  readonly team?: { readonly members: readonly {
    readonly baseRole: string;
    readonly expert?: object;
    readonly role: { readonly allowedTools?: readonly string[] | undefined; readonly disallowedTools?: readonly string[] | undefined };
  }[] };
};

/** No report prose is interpreted as a task family, purpose or dependency.
 * Without a host snapshot this identifies only the reported owner population. */
export function collaborationSourceCondition(issue: LearningIssue, host?: CollaborationConditionHost): CollaborationSourceCondition | undefined {
  const reports = issue.reports.filter(isTeamLearningIssueReport);
  const sourceOwnerClasses = [...new Set(reports.map(report => report.source.memberId === "personal_agent" ? "personal_agent" : "team_member"))].sort();
  if (sourceOwnerClasses.length === 0) return undefined;

  const features: JsonObject = { schema: "collaboration-source-condition/v1", sourceOwnerClasses,
    selectedPopulation: host === undefined ? "reported_owner_population_only" : "frozen_host_structure",
    taskPurpose: "not_identified",
    ...(host === undefined ? {} : { surface: host.surface, arrangement: host.team === undefined ? "personal_agent" : "frozen_team",
      memberCount: host.team?.members.length ?? 0, memberClasses: memberClasses(host) }) };
  const sourceRef = host?.sourceRef ?? `collaboration-report-source:${contentHashOf(reports.map(report => report.reportId))}`;

  return { ref: `collaboration-condition:${contentHashOf(features)}`, sourceRef, features };
}

function memberClasses(host: CollaborationConditionHost): JsonObject[] {
  const classes = new Map<string, { readonly features: JsonObject; count: number }>();

  for (const member of host.team?.members ?? []) {
    const features: JsonObject = { baseRole: member.baseRole, configurationClass: member.expert === undefined ? "base_role" : "expert_selection",
      allowedTools: member.role.allowedTools === undefined ? null : [...new Set(member.role.allowedTools)].sort(),
      disallowedTools: member.role.disallowedTools === undefined ? null : [...new Set(member.role.disallowedTools)].sort() };
    const key = canonicalJson(features), prior = classes.get(key);
    if (prior === undefined) classes.set(key, { features, count: 1 });else prior.count += 1;
  }

  return [...classes.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, group]) => ({ ...group.features, count: group.count }));
}
