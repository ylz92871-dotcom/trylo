import { createCentralToolExecutor } from "../../integration/central-learning/tool-executor.js";
import type { CentralLearningExecutionPort } from "../../integration/central-learning/contracts.js";
import type { RunCommandOptions } from "./args.js";
import { runToolCycle } from "./tool-cycle-wiring.js";
import { toolResearchServices } from "./tool-research-wiring.js";
import type { CentralRuntimeDomainsInput } from "./central-runtime-domains-contracts.js";

/** The independent owner lends frozen transport, never a foreground execution
 * allowance. Actual tool construction/checks retain their original Permission. */
export function createCentralRuntimeTool(options: CentralRuntimeDomainsInput): CentralLearningExecutionPort {
  const provider = options.provider.fork?.([]);
  if (provider === undefined || provider === options.provider) throw new Error("central_tool_provider_isolation_required");

  const ctx = { ...options.ctx, cwd: options.scope, stdinIsTty: false };
  const run: RunCommandOptions = { message: [], readStdin: false, model: options.model };

  return createCentralToolExecutor({ boardRoot: options.boardRoot, scope: options.workspaceId, centralScope: options.scope,
    now: ctx.now, authorized: options.enabled, modelRef: options.modelRef, mode: "after_turn", executionAuthorized: false,
    contextForIssue: options.contextForIssue,
    contextServices: toolResearchServices(ctx, { boardRoot: options.boardRoot, scope: options.workspaceId, run }),
    run: (jobId, managedBinding, signal) => runToolCycle(ctx, { boardRoot: options.boardRoot, scope: options.workspaceId,
      centralScope: options.scope, run, mode: "after_turn", jobIds: [jobId], maxJobs: 1, managedBinding, signal,
      frozenModel: { provider, model: options.model,
        ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }) } }),
  });
}
