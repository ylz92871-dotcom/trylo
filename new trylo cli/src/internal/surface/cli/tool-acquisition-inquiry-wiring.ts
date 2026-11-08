import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import { createToolLearningFunding } from "../../learning/agent/subsystems/tool/runtime/learning-funding.js";
import { openToolEvolutionSession, type ToolEvolutionSession } from "./tool-evolution-session.js";
import { toolResearchServices } from "./tool-research-wiring.js";
import { runAcquisitionInquiry } from "../../learning/agent/subsystems/tool/runtime/acquisition-inquiry.js";
import { ToolLearningServiceError } from "../../learning/agent/subsystems/tool/domain/evolution/service-error.js";

/** Explicit same-grant research. No source execution, install or activation service is supplied. */
export function runToolAcquisitionInquiry(ctx: CliContext, input: {
  readonly boardRoot: string; readonly jobId: string; readonly scope: string; readonly approvalId: string;
  readonly failureRef: string; readonly reviewId: string; readonly signal: AbortSignal; readonly run: RunCommandOptions;
}) {
  return runAcquisitionInquiry({ ...input, now: ctx.now, services: async continuationJobId => {
    const funding = createToolLearningFunding({ boardRoot: input.boardRoot, scope: input.scope, centralScope: ctx.cwd, now: ctx.now, continuationJobId });
    let session: ToolEvolutionSession | undefined;
    const active = () => {
      if (session !== undefined) return session;
      const opened = openToolEvolutionSession(ctx, input.run, { boardRoot: input.boardRoot, mode: "manual", funding });
      if ("exitCode" in opened) throw new ToolLearningServiceError("provider_configuration_unavailable");
      return session = opened;
    };

    return { ...toolResearchServices(ctx, input), executionAuthorized: false,
      allowance: plan => funding.allowance(plan), plan: (context, signal) => active().plan(context, signal),
      evolve: async () => { throw new ToolLearningServiceError("acquisition_inquiry_research_only"); },
      releaseAllowance: async () => { try { await session?.close(); } finally { await funding.release(); } },
    };
  } });
}
