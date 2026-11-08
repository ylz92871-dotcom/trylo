import path from "node:path";
import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import { tryloHome } from "./session-paths.js";
import { openToolEvolutionSession } from "./tool-evolution-session.js";
import { authorizeToolCheck } from "./tool-check-permission.js";
import type { createToolLearningFunding } from "../../learning/agent/subsystems/tool/runtime/learning-funding.js";
import type { ToolLearningPlan } from "../../learning/agent/subsystems/tool/domain/evolution/pipeline.js";
import type { NpmAdaptationServices } from "../../learning/agent/subsystems/tool/runtime/npm-adaptation-runtime.js";
import { prepareNpmToolAdaptation } from "../../learning/agent/subsystems/tool/runtime/npm-adaptation-runtime.js";
import { toolLearningParentFromBoard } from "../../learning/agent/subsystems/tool/runtime/learning-parent.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { ToolJobAdmission } from "../../learning/agent/subsystems/tool/runtime/evolution-archive.js";
import { pipelineFailure } from "../../learning/agent/subsystems/tool/runtime/pipeline-assets.js";
import { toolUseFeedback } from "../../learning/agent/subsystems/tool/domain/evolution/use.js";
import { toolLearningFeedbackRequirements, toolLearningNpmParents } from "../../learning/agent/subsystems/tool/runtime/learning-context.js";

export function npmAdaptationServices(ctx: CliContext, input: { readonly boardRoot: string; readonly plan: ToolLearningPlan;
  readonly run: RunCommandOptions; readonly funding: ReturnType<typeof createToolLearningFunding>;
  readonly complete: NpmAdaptationServices["complete"] }): NpmAdaptationServices {
  let permission: Promise<boolean> | undefined;
  return { complete: input.complete, allowance: () => input.funding.allowance(input.plan),
    ...(ctx.toolProduction?.execute === undefined ? {} : { execute: async (plan, value, signal) => {
      permission ??= authorizeToolCheck(ctx, input.run, { installationId: plan.origin.versionId,
        learningJobId: input.plan.trigger.proposalKey, action: "check_new_immutable_npm_adaptation" }, signal);
      return await permission ? ctx.toolProduction!.execute!(plan, value, signal)
        : { kind: "unavailable" as const, detail: "npm adaptation execution authorization was not granted" };
    } }) };
}

/** A feedback-triggered revision reuses the exact reviewed package, never a fresh latest install. */
export async function adaptExistingNpmTool(ctx: CliContext, input: { readonly boardRoot: string; readonly scope: string; readonly run: RunCommandOptions;
  readonly funding: ReturnType<typeof createToolLearningFunding>; readonly session: ReturnType<typeof openToolEvolutionSession>;
  readonly plan: ToolLearningPlan; readonly parentVersionId: string; readonly adaptation: string; readonly admission: ToolJobAdmission; readonly signal: AbortSignal }) {
  if ("exitCode" in input.session) return pipelineFailure("provider_configuration_unavailable", "The selected provider is unavailable");

  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const selected = toolLearningParentFromBoard(loaded.state, input.parentVersionId);
  if (!selected.ok) return selected;

  if (selected.parent.kind !== "npm" || selected.parent.scope !== input.scope) return pipelineFailure("planning_parent_mismatch", input.parentVersionId);

  const parent = selected.parent, session = input.session;
  const parents = toolLearningNpmParents(loaded.state, input.plan), requirements = toolLearningFeedbackRequirements(loaded.state, input.plan);
  if (!parents.ok) return parents;

  if (!requirements.ok) return requirements;

  const feedback = parents.parents.find(item => item.versionId === parent.versionId)?.feedback
    ?? toolUseFeedback((loaded.state.toolUses ?? []).filter(use => use.versionId === parent.versionId)) ?? "No attributed feedback available";

  return prepareNpmToolAdaptation({ ...input, workspaceId: parent.plan.workspaceId, installation: parent.plan.installation,
    installationRoot: path.join(tryloHome(ctx.homeDir, ctx.env), "learning/tool/installations"), now: ctx.now,
    requirements: requirements.requirements, parent: { versionId: parent.versionId, plan: parent.plan, feedback }, services: npmAdaptationServices(ctx,
      { ...input, complete: (prompt, signal, phase) => session.complete(prompt, signal, phase) }) });
}
