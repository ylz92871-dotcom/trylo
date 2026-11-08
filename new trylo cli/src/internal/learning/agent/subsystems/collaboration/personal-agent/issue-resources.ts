import { isCollaborationPlan } from "../orchestration/parse.js";
import { isExpertIdentityReference, isPrepareExperienceInput } from "../experience/parse.js";

type Row = Record<string, unknown>;

const row = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const rows = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
const count = (value: unknown): number | "unknown" => Array.isArray(value) ? value.length : "unknown";
const text = (value: unknown, max = 512): value is string => typeof value === "string" && !!value.trim() && value.length <= max && !value.includes("\0");
const number = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const fields = (value: Row, keys: readonly string[]): Row => Object.fromEntries(keys.flatMap(key => {
  const item = value[key];
  return text(item) || number(item) ? [[key, item]] : [];
}));
const OWNER_LIMIT = 12, REQUEST_LIMIT = 8, MEMBER_LIMIT = 16, PLAN_LIMIT = 8;

function teamSummary(value: unknown) {
  if (!row(value)) return { unavailable: "team_not_supplied", omittedMembers: "unknown" as const };

  const members = rows(value.members).flatMap(member => {
    if (!row(member) || !text(member.memberId, 200)) return [];

    const role = row(member.role) ? member.role : {};
    const expert = row(member.expert) ? fields(member.expert, ["expertId", "requestId", "version"]) : undefined;
    const prepared = row(member.lastPreparedBoundary) ? member.lastPreparedBoundary : undefined;

    return [{ ...fields(member, ["memberId", "baseRole", "configurationRef"]),
      role: { ...fields(role, ["name", "model"]), ...(text(role.description, 300) ? { description: role.description } : {}),
        descriptionOmitted: role.description !== undefined && !text(role.description, 300),
        frozenAllowedToolCount: count(role.allowedTools), skillCount: count(role.skills) },
      ...(prepared === undefined ? {} : { lastPreparedBoundary: {
        ...fields(prepared, ["executionId", "taskId", "round", "configurationRef"]),
        ...(isExpertIdentityReference(prepared.identity) ? { identity: structuredClone(prepared.identity) } : {}),
        responsibilities: rows(prepared.responsibilities).filter(item => text(item, 200)).slice(0, 8),
        note: "Last actual prepare boundary; not evidence of provider exposure, current liveness or quality." } }),
      ...(expert === undefined ? {} : { expert }) }];
  });

  return { ...fields(value, ["runId", "profileId", "surface", "configurationBasis"]), members: members.slice(0, MEMBER_LIMIT),
    omittedMembers: rows(value.members).length - Math.min(members.length, MEMBER_LIMIT) };
}

function requestSummaries(value: unknown, issueId: string) {
  const related = rows(value).filter(request => row(request) && row(request.association) && request.association.issueId === issueId);
  const items = related.flatMap(request => {
    if (!row(request) || !text(request.requestId) || !text(request.expertId) || !text(request.state) || !number(request.revision)) return [];
    return [{ ...fields(request, ["requestId", "expertId", "experienceKey", "state", "revision", "baseVersion", "origin", "configurationRef"]),
      association: row(request.association) ? fields(request.association, ["issueId", "jobId", "grantId", "correlationRef"]) : {} }];
  }).slice(-REQUEST_LIMIT);

  return { items, providedCount: count(value), unrelatedProvided: rows(value).length - related.length, omittedRelated: related.length - items.length };
}

function ownerSummaries(value: unknown) {
  const items = rows(value).flatMap(owner => {
    if (!row(owner) || !text(owner.ref) || !isPrepareExperienceInput(owner.input)) return [];
    return [{ ref: owner.ref, input: structuredClone(owner.input),
      ...(isExpertIdentityReference(owner.identity) ? { identity: structuredClone(owner.identity) } : {}) }];
  }).slice(0, OWNER_LIMIT);
  return { items, providedCount: count(value), omitted: rows(value).length - items.length };
}

/** Projection only. The host hashes the complete resource revision before calling this function. */
export function projectIssueResources(resources: unknown, issueId: string) {
  if (!row(resources)) return { schema: "collaboration-issue-resources/v1", issueId, unavailable: "resource_view_invalid" };

  const relatedPlans = rows(resources.plans).filter(plan => row(plan) && row(plan.content) && plan.content.issueId === issueId);
  const plans = relatedPlans.flatMap(plan => !row(plan) || !text(plan.versionId) || !isCollaborationPlan(plan.content) ? []
    : [{ versionId: plan.versionId, content: structuredClone(plan.content) }]).slice(-PLAN_LIMIT);
  const requests = requestSummaries(resources.expertRequests, issueId), owners = ownerSummaries(resources.owners);
  const toolResult = row(resources.tools) && resources.tools.ok === true && row(resources.tools.value) ? resources.tools.value : undefined;
  const toolTotal = toolResult?.total;

  return structuredClone({ schema: "collaboration-issue-resources/v1", issueId,
    objective: resources.objective, followUp: resources.followUp, team: teamSummary(resources.team),
    plans, ...(resources.planSummary === undefined ? {} : { planSummary: resources.planSummary }), expertRequests: requests.items, owners: owners.items,
    experts: { details: "omitted", providedCount: count(resources.experts), catalogueTotal: "unknown", libraryTool: "library_expert", operation: "query/get" },
    tools: { details: "omitted", providedCount: count(toolResult?.items), catalogueTotal: number(toolTotal) ? toolTotal : "unknown",
      libraryTool: "library_tool", operation: "query" },
    omitted: {
      plans: { providedCount: count(resources.plans), unrelatedProvided: rows(resources.plans).length - relatedPlans.length, related: relatedPlans.length - plans.length },
      expertRequests: { providedCount: requests.providedCount, unrelatedProvided: requests.unrelatedProvided, related: requests.omittedRelated },
      owners: { providedCount: owners.providedCount, omitted: owners.omitted }, receipts: { details: "omitted", providedCount: count(resources.receipts) },
      fields: ["team member role prompt/tool and skill details", "expert request configuration/instruction/userEdits/feedback/authorization", "expert catalogue configurations", "tool catalogue details"],
      note: "Counts describe the supplied host view, which may already be bounded. Omitted or unexpanded resources are not empty libraries. Use the original PA library tools for full canonical records; this projection grants no authority.",
    } });
}
