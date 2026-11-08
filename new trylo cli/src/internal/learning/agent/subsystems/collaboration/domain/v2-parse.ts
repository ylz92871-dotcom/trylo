import { COLLABORATION_DIMENSIONS, type CollaborationActionV2, type CollaborationAnalysisPortV2, type CollaborationPracticeDraftV2,
  type CollaborationPracticeV2, type CollaborationV2Context, type CollaborationV2Fact, type CollaborationGrantV2 } from "./v2-contracts.js";

type Row = Record<string, unknown>;

const row = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 2000): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const list = (v: unknown, guard: (x: unknown) => boolean, max = 32): v is unknown[] => Array.isArray(v) && v.length <= max && v.every(guard);
const refs = (v: unknown): v is string[] => list(v, x => text(x, 512)) && new Set(v).size === v.length;
const one = (v: unknown, values: readonly string[]): boolean => typeof v === "string" && values.includes(v);
const number = (v: unknown, max = 1000000000): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
const integer = (v: unknown, max = 1000000000): v is number => number(v, max) && Number.isSafeInteger(v);
const exact = (v: Row, keys: readonly string[]): boolean => Object.keys(v).every(key => keys.includes(key));
const sources = ["runtime", "peer_report", "external_checker", "user"];
const causes = ["capability_gap", "task_difficulty", "coordination", "unknown"];
const modes = ["sequential", "parallel", "mixed", "unknown"];
const difficulties = ["routine", "hard", "unknown"];
const base = ["schemaVersion", "factId", "scope", "recordedAt", "kind"];
export const ACTION_DIMENSIONS: Readonly<Record<CollaborationActionV2["operation"], string>> = {
  split_task: "decomposition", assign_member: "assignment", request_context: "handoff", synchronize: "synchronization",
  share_reference: "information_sharing", schedule_review: "review", wait_for_dependency: "waiting", replan: "rework",
};

export function isCollaborationV2Context(v: unknown): v is CollaborationV2Context {
  if (!row(v) || !exact(v, ["scope", "teamRunId", "taskId", "round", "memberId", "role", "taskFamily", "dependency", "coordinationMode", "difficulty", "members", "taskConditionRefs"])) return false;

  if (![v.scope, v.teamRunId, v.taskId, v.memberId, v.role, v.taskFamily].every(x => text(x, 512))
    || ["global", "*", "broad"].includes(String(v.scope).trim().toLowerCase()) || !integer(v.round, 100000) || v.round < 1
    || !one(v.dependency, ["artifact", "independent", "unknown"]) || !one(v.coordinationMode, modes) || !one(v.difficulty, difficulties)
    || (v.taskConditionRefs !== undefined && !refs(v.taskConditionRefs))
    || !list(v.members, x => row(x) && exact(x, ["memberId", "role", "model", "capabilityRefs"]) && text(x.memberId, 200) && text(x.role, 200)
      && (x.model === undefined || text(x.model, 200)) && (x.capabilityRefs === undefined || refs(x.capabilityRefs)), 16) || v.members.length === 0) return false;

  const members = v.members.filter(row);

  return new Set(members.map(x => x.memberId)).size === members.length
    && ((v.memberId === "parent" && v.role === "parent") || members.some(x => x.memberId === v.memberId && x.role === v.role));
}

function isCondition(v: unknown): boolean {
  return row(v) && exact(v, ["dependency", "taskFamilies", "roles", "coordinationModes", "difficulty", "minimumMembers"])
    && one(v.dependency, ["artifact", "independent", "any"]) && refs(v.taskFamilies) && refs(v.roles)
    && refs(v.coordinationModes) && v.coordinationModes.every(x => modes.includes(x))
    && refs(v.difficulty) && v.difficulty.every(x => difficulties.includes(x))
    && integer(v.minimumMembers, 16) && v.minimumMembers >= 1;
}

export function isCollaborationActionV2(v: unknown): v is CollaborationActionV2 {
  return row(v) && exact(v, ["actionId", "dimension", "audience", "operation", "instruction", "expectedObservable"])
    && text(v.actionId, 200) && one(v.dimension, COLLABORATION_DIMENSIONS) && one(v.audience, ["parent", "member"])
    && typeof v.operation === "string" && Object.hasOwn(ACTION_DIMENSIONS, v.operation)
    && ACTION_DIMENSIONS[v.operation as CollaborationActionV2["operation"]] === v.dimension
    && text(v.instruction, 1200) && text(v.expectedObservable, 500);
}

const draftKeys = ["familyId", "title", "hypothesis", "alternatives", "discriminator", "conditions", "actions", "failureConditions", "sourceEventIds", "sourceEpisodeIds", "sourceOutcomeIds", "parentVersionId"];

function isDraft(v: unknown, extraKeys: readonly string[] = []): v is CollaborationPracticeDraftV2 {
  if (!row(v) || !exact(v, [...draftKeys, ...extraKeys]) || !text(v.familyId, 200) || !text(v.title, 200) || !text(v.hypothesis, 1500)
    || !isCondition(v.conditions) || !list(v.actions, isCollaborationActionV2, 8) || v.actions.length === 0
    || !refs(v.failureConditions) || !refs(v.sourceEventIds) || !refs(v.sourceEpisodeIds) || !refs(v.sourceOutcomeIds)
    || v.sourceEventIds.length + v.sourceEpisodeIds.length + v.sourceOutcomeIds.length === 0 || (v.parentVersionId !== undefined && !text(v.parentVersionId, 200))) return false;

  if (!list(v.alternatives, x => row(x) && exact(x, ["cause", "explanation", "evidenceRefs"]) && one(x.cause, causes)
    && text(x.explanation, 1000) && refs(x.evidenceRefs), 4) || v.alternatives.length < 2) return false;

  const alternatives = v.alternatives.filter(row);
  if (new Set(alternatives.map(x => x.cause)).size !== alternatives.length) return false;

  return row(v.discriminator) && exact(v.discriminator, ["observation", "distinguishes"]) && text(v.discriminator.observation, 1000)
    && refs(v.discriminator.distinguishes) && v.discriminator.distinguishes.length >= 2
    && v.discriminator.distinguishes.every(x => causes.includes(x));
}

export function isCollaborationPracticeV2(v: unknown): v is CollaborationPracticeV2 {
  if (!row(v)) return false;
  const { schema, status, sourceWindowHash, cycleId } = v;
  return isDraft(v, ["schema", "status", "sourceWindowHash", "cycleId"])
    && schema === "collaboration-practice/v2" && status === "trial" && text(sourceWindowHash, 200) && text(cycleId, 200);
}

function metrics(v: unknown): boolean {
  return row(v) && exact(v, ["delivery", "handoffCompleteness", "reworkCount", "waitMs", "tokenCost"])
    && one(v.delivery, ["passed", "failed", "unverified"])
    && (v.handoffCompleteness === undefined || number(v.handoffCompleteness, 1))
    && [v.reworkCount, v.waitMs, v.tokenCost].every(x => x === undefined || number(x));
}

function eventMetrics(v: unknown): boolean {
  return row(v) && exact(v, ["waitMs", "reworkCount", "tokenCost", "memberCount", "taskCount"])
    && Object.values(v).every(x => number(x));
}

export function isCollaborationGrantV2(v: unknown): v is CollaborationGrantV2 {
  return row(v) && exact(v, ["maxSteps", "maxModelCalls", "maxModelTokens", "maxPromptChars"])
    && integer(v.maxSteps, 64) && integer(v.maxModelCalls, 16) && integer(v.maxModelTokens, 1000000) && integer(v.maxPromptChars, 8000);
}

function usage(v: unknown): boolean {
  return v === undefined || (row(v) && exact(v, ["status", "elapsedMs", "inputTokens", "outputTokens", "totalTokens", "model", "providerId"])
    && one(v.status, ["reported", "reserved_unknown"]) && number(v.elapsedMs)
    && [v.inputTokens, v.outputTokens, v.totalTokens].every(x => x === undefined || integer(x))
    && [v.model, v.providerId].every(x => x === undefined || text(x, 200)));
}

export function isCollaborationV2Fact(v: unknown): v is CollaborationV2Fact {
  if (!row(v) || v.schemaVersion !== 2 || !text(v.factId, 512) || !text(v.scope, 512) || !text(v.recordedAt, 64)
    || !Number.isFinite(Date.parse(v.recordedAt))) return false;
  switch (v.kind) {
    case "event": return exact(v, [...base, "context", "dimension", "action", "summary", "source", "evidenceRefs", "causedBy", "metrics"])
      && isCollaborationV2Context(v.context) && v.context.scope === v.scope && one(v.dimension, COLLABORATION_DIMENSIONS)
      && text(v.action, 200) && text(v.summary, 1500) && one(v.source, sources) && refs(v.evidenceRefs) && refs(v.causedBy) && eventMetrics(v.metrics);
    case "episode": return exact(v, [...base, "context", "eventIds", "metrics", "source", "evidenceRefs"])
      && isCollaborationV2Context(v.context) && v.context.scope === v.scope && refs(v.eventIds) && v.eventIds.length > 0
      && metrics(v.metrics) && one(v.source, sources) && refs(v.evidenceRefs) && authorityConsistent(v);
    case "exposure": return exact(v, [...base, "context", "selectionId", "versionId", "actionIds", "audience", "requestId", "contentHash"])
      && isCollaborationV2Context(v.context) && v.context.scope === v.scope && [v.selectionId, v.versionId, v.requestId, v.contentHash].every(x => text(x, 512))
      && refs(v.actionIds) && v.actionIds.length > 0 && one(v.audience, ["parent", "member"]);
    case "adoption": return exact(v, [...base, "exposureId", "actionId", "eventIds"])
      && text(v.exposureId, 512) && text(v.actionId, 200) && refs(v.eventIds) && v.eventIds.length > 0;
    case "outcome": return exact(v, [...base, "adoptionIds", "episodeIds", "metrics", "source", "evidenceRefs"])
      && refs(v.adoptionIds) && refs(v.episodeIds) && v.adoptionIds.length + v.episodeIds.length > 0
      && metrics(v.metrics) && one(v.source, sources) && refs(v.evidenceRefs) && authorityConsistent(v);
    case "correction": return exact(v, [...base, "familyId", "appliesTo", "action", "replacesCorrectionId", "evidenceRef"])
      && text(v.familyId, 200) && correctionScope(v.appliesTo) && one(v.action, ["suspend", "restore"])
      && (v.replacesCorrectionId === undefined || text(v.replacesCorrectionId, 512)) && text(v.evidenceRef, 512);
    case "cycle": return exact(v, [...base, "cycleId", "requestId", "phase", "step", "grant", "spent", "cursor", "sourceWindowHash", "reason", "usage", "claimOwner", "claimExpiresAt", "pinnedFactIds"])
      && text(v.cycleId, 200) && text(v.requestId, 200) && one(v.phase, ["running", "reserved", "completed", "cancelled", "waiting_evidence", "failed"])
      && integer(v.step, 64) && isCollaborationGrantV2(v.grant) && row(v.spent) && exact(v.spent, ["steps", "modelCalls", "modelTokens"])
      && [v.spent.steps, v.spent.modelCalls, v.spent.modelTokens].every(x => integer(x)) && integer(v.cursor)
      && text(v.sourceWindowHash, 200) && (v.reason === undefined || text(v.reason, 1000)) && usage(v.usage)
      && (v.claimOwner === undefined || text(v.claimOwner, 200)) && (v.claimExpiresAt === undefined || (text(v.claimExpiresAt, 64) && Number.isFinite(Date.parse(v.claimExpiresAt))))
      && (v.pinnedFactIds === undefined || list(v.pinnedFactIds, x => text(x, 512), 256));
    case "analysis": return exact(v, [...base, "cycleId", "step", "sourceWindowHash", "throughCursor", "basis", "result"])
      && text(v.cycleId, 200) && integer(v.step, 64) && text(v.sourceWindowHash, 200) && integer(v.throughCursor)
      && row(v.basis) && exact(v.basis, ["boardSequence", "eventIds", "episodeIds", "outcomeIds", "practiceVersionIds", "exposureIds", "adoptionIds", "projection"])
      && integer(v.basis.boardSequence) && list(v.basis.eventIds, x => text(x, 512), 64) && new Set(v.basis.eventIds).size === v.basis.eventIds.length
      && [v.basis.episodeIds, v.basis.outcomeIds, v.basis.practiceVersionIds, v.basis.exposureIds, v.basis.adoptionIds].every(refs)
      && (v.basis.projection === undefined || (row(v.basis.projection) && exact(v.basis.projection, ["omittedEventCount", "fullEventSetHash"])
        && integer(v.basis.projection.omittedEventCount) && v.basis.projection.omittedEventCount > 0 && text(v.basis.projection.fullEventSetHash, 200)))
      && isCollaborationAnalysisResultV2(v.result);
    default: return false;
  }
}

function authorityConsistent(v: Row): boolean {
  if (!row(v.metrics)) return false;
  return v.metrics.delivery === "unverified" || ((v.source === "external_checker" || v.source === "user")
    && Array.isArray(v.evidenceRefs) && v.evidenceRefs.length > 0);
}

function correctionScope(v: unknown): boolean {
  return row(v) && ((v.kind === "once" && exact(v, ["kind", "taskId"]) && text(v.taskId, 512))
    || (v.kind === "class" && exact(v, ["kind", "taskFamily", "role"]) && text(v.taskFamily, 512) && text(v.role, 200))
    || (v.kind === "workspace" && exact(v, ["kind"])));
}

type ParsedAnalysis = { readonly status: "proposed"; readonly proposals: readonly CollaborationPracticeDraftV2[] }
  | { readonly status: "no_change"; readonly reason: string };

export function parseCollaborationAnalysisResponseV2(v: unknown): { readonly ok: true; readonly value: ParsedAnalysis }
  | { readonly ok: false; readonly reason: string } {
  if (row(v) && v.status === "no_change" && exact(v, ["status", "reason"]) && text(v.reason, 1500)) return { ok: true, value: { status: "no_change", reason: v.reason } };
  if (row(v) && v.status === "proposed" && exact(v, ["status", "proposals"]) && list(v.proposals, x => isDraft(x), 4)
    && v.proposals.length > 0) return { ok: true, value: { status: "proposed", proposals: v.proposals.filter((x): x is CollaborationPracticeDraftV2 => isDraft(x)) } };
  return { ok: false, reason: "collaboration_analysis_shape" };
}

export function isCollaborationAnalysisResultV2(v: unknown): v is Awaited<ReturnType<CollaborationAnalysisPortV2["analyze"]>> {
  if (!row(v) || !integer(v.tokenCost) || !usage(v.usage)) return false;
  const { tokenCost: _cost, usage: _usage, ...body } = v;
  return v.status === "failed" ? exact(body, ["status", "reason"]) && text(body.reason, 1500) : parseCollaborationAnalysisResponseV2(body).ok;
}
