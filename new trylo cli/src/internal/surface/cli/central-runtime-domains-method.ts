import { createCentralMethodExecutor } from "../../integration/central-learning/method-executor.js";
import type { CentralLearningExecutionPort } from "../../integration/central-learning/contracts.js";
import type { CentralRuntimeDomainsInput } from "./central-runtime-domains-contracts.js";

/** Scope-owned method research reuses its original source, snapshot and grant.
 * The instance identity is not a business turn and carries no frontend lifetime. */
export function createCentralRuntimeMethod(options: CentralRuntimeDomainsInput): CentralLearningExecutionPort {
  const provider = options.provider.fork?.([]);
  if (provider === undefined || provider === options.provider) throw new Error("central_method_provider_isolation_required");

  return createCentralMethodExecutor({ boardRoot: options.boardRoot, scope: options.scope,
    workspaceId: options.workspaceId, turnId: options.ctx.newId("central-method-research"),
    provider, model: options.model, modelRef: options.modelRef, authorized: options.enabled,
    contextForIssue: options.contextForIssue, now: () => new Date(options.ctx.now()).toISOString(),
    emit: (kind, payload) => options.ctx.stderr(`${JSON.stringify({ component: "central_method_research", kind, payload })}\n`),
  });
}
