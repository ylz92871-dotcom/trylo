import { permissionPattern, isPermissionDecision } from "../../../ports/permission.js";
import type { PermissionPort } from "../../../ports/permission.js";
import { contentHashOf } from "../../../learning/control/hash.js";
import { enqueueToolLearningPlan, readToolLearningPipeline, readToolAssetInventory } from "../../../learning/agent/subsystems/tool/runtime/index.js";
import type { ToolLearningPlan } from "../../../learning/agent/subsystems/tool/domain/evolution/index.js";
import type { CapabilityDemand, CapabilityRequest, ToolLibraryContext, ToolLibraryLearning } from "../contracts.js";
import { runtimeToolId } from "../resolution.js";
import { libraryFailure } from "../service.js";

type Options = {
  readonly boardRoot: string;
  readonly permission: (context: ToolLibraryContext) => PermissionPort;
  readonly now: () => number;
};

function ownerKey(context: ToolLibraryContext): string { return `tool-library:v1:${contentHashOf(context)}:`; }

function proposalKey(context: ToolLibraryContext, demand: CapabilityDemand): string { return `${ownerKey(context)}${contentHashOf(demand.requestKey)}`; }

/** Uses the existing Permission service and Board queue. This adapter never runs workers or grants quota. */
export function createBoardToolLearning(options: Options): ToolLibraryLearning {
  const get: ToolLibraryLearning["get"] = async (context, requestId) => {
    const loaded = await readToolLearningPipeline(options.boardRoot);
    if (!loaded.ok) return loaded;

    const job = loaded.jobs.find(row => row.jobId === requestId && row.scope === context.scope && row.plan?.trigger.proposalKey.startsWith(ownerKey(context)));
    if (job?.plan === undefined) return libraryFailure("request_not_found", "no capability request belongs to this member and scope");

    const toolIds: string[] = [];

    if (job.result?.decision?.action === "reuse") toolIds.push(job.result.decision.toolId);

    if (job.result?.candidateVersionId !== undefined) {
      const inventory = await readToolAssetInventory(options.boardRoot, context.scope);
      if (!inventory.ok) return inventory;
      for (const item of inventory.items) {
        if (item.lifecycle === "active" && item.runtimeName !== undefined && item.originVersionId === job.result.candidateVersionId) toolIds.push(runtimeToolId(item.runtimeName));
      }
    }

    const value: CapabilityRequest = { requestId, capability: job.plan.capability, state: job.state, toolIds, relatedRefs: job.plan.trigger.evidenceRefs,
      ...(job.result === undefined ? {} : { reason: job.result.code }),
      ...(job.result?.candidateVersionId === undefined ? {} : { assetVersionId: job.result.candidateVersionId }) };

    return { ok: true, value };
  };
  return { get, async request(context, demand, signal) {
    const loaded = await readToolLearningPipeline(options.boardRoot);
    if (!loaded.ok) return loaded;

    const key = proposalKey(context, demand);
    const existing = loaded.jobs.find(row => row.scope === context.scope && row.plan?.trigger.proposalKey === key);
    if (existing?.plan !== undefined) return matchesDemand(existing.plan, demand)
      ? get(context, existing.jobId) : libraryFailure("request_key_conflict", "requestKey already identifies a different task or capability");

    if (signal.aborted) return libraryFailure("cancelled", "capability request cancelled");

    const permission = options.permission(context), args = { memberId: context.memberId, scope: context.scope, capability: demand.capability, taskId: demand.taskId, requestKey: demand.requestKey, relatedRefs: [...(demand.relatedRefs ?? [])], targetToolId: demand.targetToolId ?? null };
    const callId = `tool-library:${contentHashOf(args)}`, name = "tool_library_acquire";
    const ticket = await permission.request({ toolCallId: callId, name, arguments: args, pattern: permissionPattern(name, args) }, { signal });
    const decision = await permission.awaitDecision(ticket.ticketId, { signal });

    if (signal.aborted) return libraryFailure("cancelled", "capability request cancelled");

    if (!isPermissionDecision(decision) || decision.resolution !== "approved") return libraryFailure("acquisition_not_approved", "new tool discovery/adaptation/creation requires user consent");

    // Re-read after consent; Board's dedupe key is the cross-process arbiter.
    const repeated = await readToolLearningPipeline(options.boardRoot);
    if (!repeated.ok) return repeated;

    const previous = repeated.jobs.find(row => row.scope === context.scope && row.plan?.trigger.proposalKey === key);
    if (previous?.plan !== undefined) return matchesDemand(previous.plan, demand) ? get(context, previous.jobId)
      : libraryFailure("request_key_conflict", "requestKey already identifies a different request");

    const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: context.scope, capability: demand.capability,
      trigger: { runId: taskKey(demand), proposalKey: key, evidenceRefs: [callId, ...(demand.relatedRefs ?? [])], action: "user_requested", ...(demand.targetToolId === undefined ? {} : { tool: demand.targetToolId }) }, createdAt: new Date(options.now()).toISOString() };
    const queued = await enqueueToolLearningPlan(options.boardRoot, plan);
    if (!queued.ok && queued.code === "job_dedupe_hit") {
      const raced = await readToolLearningPipeline(options.boardRoot);
      if (!raced.ok) return raced;
      const accepted = raced.jobs.find(row => row.scope === context.scope && row.plan?.trigger.proposalKey === key);
      return accepted?.plan === undefined ? queued : matchesDemand(accepted.plan, demand) ? get(context, accepted.jobId)
        : libraryFailure("request_key_conflict", "requestKey already identifies a different request");
    }

    return queued.ok ? get(context, queued.jobId) : queued;
  } };
}

function taskKey(demand: CapabilityDemand): string { return `task:${contentHashOf(demand.taskId)}`; }

function matchesDemand(plan: ToolLearningPlan, demand: CapabilityDemand): boolean {
  const related = plan.trigger.evidenceRefs.slice(1);
  return plan.capability === demand.capability && plan.trigger.runId === taskKey(demand)
    && plan.trigger.tool === demand.targetToolId
    && contentHashOf(related) === contentHashOf(demand.relatedRefs ?? []);
}
