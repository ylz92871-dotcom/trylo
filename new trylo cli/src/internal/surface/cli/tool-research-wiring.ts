import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import type { ToolPipelineServices } from "../../learning/agent/subsystems/tool/runtime/pipeline-services.js";
import { createToolAcquisitionService } from "../../learning/agent/subsystems/tool/adapters/acquisition/search-service.js";
import { createToolResearchService } from "../../learning/agent/subsystems/tool/adapters/acquisition/research-service.js";
import { toolLearningContextFor, toolLearningLookupFor } from "./tool-learning-context.js";

/** Read-only investigation shared by ordinary learning and same-grant failure inquiries. */
export function toolResearchServices(ctx: CliContext, input: {
  readonly boardRoot: string; readonly scope: string; readonly run: RunCommandOptions;
}): Pick<ToolPipelineServices, "search" | "inspect" | "lookup" | "context"> {
  const acquisition = createToolAcquisitionService(), research = createToolResearchService();
  return {
    lookup: (query, plan, signal) => toolLearningLookupFor(ctx, input, plan, query, signal),
    inspect: (request, signal) => research.inspect(request, signal),
    context: (plan, signal) => toolLearningContextFor(ctx, input, plan, signal),

    async search(capability, signal) {
      const found = await acquisition.search({ capability, signal });
      if (!found.ok) return { status: "failed", candidates: [], failures: [{ platform: "all", stage: "search", code: found.code }] };
      return { status: found.value.status, candidates: found.value.candidates.map(candidate => ({ platform: candidate.ref.platform,
        id: candidate.ref.id, sourceUrl: candidate.sourceUrl, licenseSpdx: candidate.licenseSpdx,
        ...(candidate.ref.version === undefined ? {} : { version: candidate.ref.version }) })),
        failures: found.value.failures.map(failure => ({ platform: failure.platform, stage: failure.stage, code: failure.code })) };
    },
  };
}
