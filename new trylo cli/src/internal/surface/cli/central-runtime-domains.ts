import path from "node:path";
import { createCentralRuntimeAgentExecution } from "../../integration/central-learning/runtime-agent-execution.js";
import type { CentralLearningExecutionPort } from "../../integration/central-learning/contracts.js";
import { createCentralRuntimeCollaboration } from "./central-runtime-collaboration.js";
import { createCentralRuntimeSkill } from "./central-runtime-skill.js";
import { createCentralRuntimeMethod } from "./central-runtime-domains-method.js";
import { createCentralRuntimeTool } from "./central-runtime-domains-tool.js";
import { createCentralRuntimeWorkflow } from "./central-runtime-domains-workflow.js";
import { attachCentralRuntimeResearchReceivers } from "./central-runtime-research-receivers.js";
import { methodBoardRoot } from "./learning-sink.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import type { CentralRuntimeDomainsInput } from "./central-runtime-domains-contracts.js";

export type { CentralRuntimeDomainsInput } from "./central-runtime-domains-contracts.js";

/** Scope-owned native composition. Original domain workers, Board, provider and
 * Permission remain owners; no task wirePorts, fake Team or business journal. */
export function createCentralRuntimeDomains(input: CentralRuntimeDomainsInput) {
  if (path.resolve(input.ctx.cwd) !== path.resolve(input.scope) || !nativeWorkspaceMatches(input)
    || path.resolve(input.boardRoot) !== path.resolve(methodBoardRoot(input.ctx.homeDir, input.ctx.env))) {
    throw new Error("central_runtime_domain_owner_mismatch");
  }

  let open = true;
  const lifetime = new AbortController();
  const enabled = () => open && input.enabled();
  // The independent host supplies createCentralRuntimeContextReader with the
  // legacy source as fallback. Do not wrap it twice and duplicate its purpose.
  const owned: CentralRuntimeDomainsInput = { ...input, enabled };
  const collaboration = createCentralRuntimeCollaboration(owned), skill = createCentralRuntimeSkill(owned);
  const workflow = createCentralRuntimeWorkflow(owned);
  const original = attachCentralRuntimeResearchReceivers(owned, { workflow, collaboration: collaboration.control },
    [createCentralRuntimeMethod(owned), createCentralRuntimeTool(owned), workflow, collaboration.port, skill.port]);
  const ports = original.map((port): CentralLearningExecutionPort => ({ ...port,
    dispatch: (stage, signal) => port.dispatch(stage, AbortSignal.any([signal, lifetime.signal])),
  }));
  const execution = createCentralRuntimeAgentExecution({ boardRoot: input.boardRoot, scope: input.scope, ports,
    control: collaboration.control, enabled, now: () => new Date(input.ctx.now()).toISOString(),
    rootAllowance: input.allowance, authorizationRef: input.authorizationRef,
    ...(input.rootRef === undefined ? {} : { rootRef: input.rootRef }) });

  return {
    execution, ports,

    async nominate(signal: AbortSignal) {
      const refs: string[] = [];
      for (const port of ports) {
        if (!enabled() || signal.aborted) break;
        refs.push(...await port.nominate?.(AbortSignal.any([signal, lifetime.signal])) ?? []);
      }
      return [...new Set(refs)];
    },

    async close() {
      if (!open) return;
      open = false;
      lifetime.abort("central_runtime_scope_closed");
      const results = await Promise.allSettled([collaboration.close(), skill.close()]);
      const failed = results.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failed.length > 0) throw new AggregateError(failed.map(item => item.reason), "Central domain cleanup was not confirmed");
    },
  };
}

function nativeWorkspaceMatches(input: CentralRuntimeDomainsInput): boolean {
  if (input.workspaceId === workspaceIdentity(input.scope)) return true;

  const identity = input.ctx.workspaceIdentity;
  if (identity === undefined || input.ctx.realPath === undefined || identity.workspaceId !== input.workspaceId
    || !path.isAbsolute(identity.workspaceRoot) || !path.isAbsolute(identity.physicalRoot)
    || workspaceIdentity(identity.workspaceRoot) !== input.workspaceId || identity.budgetScope !== input.scope) return false;

  try {
    const scope = input.ctx.realPath(input.scope), workspace = input.ctx.realPath(identity.workspaceRoot);
    return scope !== undefined && workspace !== undefined && path.resolve(scope) === path.resolve(identity.physicalRoot)
      && path.resolve(workspace) === path.resolve(identity.physicalRoot);
  } catch { return false; } // Failed physical evidence cannot relax the original workspace guard.
}
