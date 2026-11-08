import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { CentralResearchReception } from "../../../../../integration/central-learning/contracts.js";
import type { GroundedCentralResearch } from "../../../../../integration/central-learning/research-intake-common.js";
import { contentHashOf } from "../../../../control/hash.js";
import { toolLearningJobId, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { planForJob } from "./pipeline-records.js";
import { nominateToolLearningSource } from "./learning-funding.js";
import { centralToolResearchCreatedAt } from "./central-research-source.js";

export interface CentralToolResearchOptions {
  readonly boardRoot: string; readonly scope: string; readonly workspaceId: string;
  readonly now: () => number; readonly enabled: () => boolean;
}

/** A research request produces an ordinary native plan. Its trigger is neither
 * a user requirement nor an external observation, and conveys no execution permission.
 */
export async function acceptCentralToolResearch(options: CentralToolResearchOptions, request: GroundedCentralResearch,
  signal: AbortSignal): Promise<CentralResearchReception> {
  const refs = [...new Set([request.requestRef, request.intent.intentId, ...request.sourceRefs])];
  const waiting = (reason: string): CentralResearchReception => ({ status: "waiting", reason, sourceRefs: refs });

  if (signal.aborted || !options.enabled()) return waiting("tool_research_inactive");

  if (request.domain !== "tool" || request.materials.length === 0) return waiting("tool_research_grounding_required");

  if (refs.length > 32 || refs.some(ref => ref.length > 512)) return waiting("tool_research_source_capacity");

  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return waiting(loaded.reason);

  const existing = loaded.state.jobs.flatMap(job => {
    const plan = planForJob(loaded.state, job.jobId);
    return plan?.scope === options.workspaceId && plan.trigger.action === "central_research"
      && plan.trigger.proposalKey === request.requestRef ? [plan] : [];
  });
  if (existing.length > 1) return waiting("tool_research_source_conflict");

  const timestamp = existing[0] === undefined ? await centralToolResearchCreatedAt(options, request.requestRef, signal)
    : { ok: true as const, createdAt: existing[0].createdAt };
  if (!timestamp.ok) return waiting(timestamp.reason);

  const createdAt = timestamp.createdAt;
  const plan: ToolLearningPlan = existing[0] ?? { type: "tool_learning_plan", schemaVersion: 1,
    scope: options.workspaceId, capability: request.intent.goal.slice(0, 512), createdAt,
    trigger: { runId: `tool-research:${contentHashOf(request.requestRef)}`, proposalKey: request.requestRef,
      action: "central_research", evidenceRefs: refs } };

  if (signal.aborted || !options.enabled()) return waiting("tool_research_inactive");

  const enqueued = await enqueueToolLearningPlan(options.boardRoot, plan,
    { commandGuard: () => !signal.aborted && options.enabled() });
  if (!enqueued.ok) return waiting(enqueued.code);

  if (signal.aborted || !options.enabled()) return waiting("tool_research_inactive");

  const nominated = await nominateToolLearningSource({ boardRoot: options.boardRoot, scope: options.workspaceId,
    centralScope: options.scope, now: options.now }, plan, signal);

  return nominated.ok ? { status: "accepted", issueId: nominated.issueId,
    sourceRefs: [...new Set([...refs, toolLearningJobId(plan)])] } : waiting(nominated.code);
}
