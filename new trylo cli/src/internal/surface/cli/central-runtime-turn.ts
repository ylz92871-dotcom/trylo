import path from "node:path";
import { attachCentralRuntime, readRuntimeIntent, runtimeScopePaths, type CentralRuntimeClient } from "../../adapters/central-learning-runtime/index.js";
import { sessionContentAddress } from "../../integration/learning-content/sources/session.js";
import { centralRuntimeConfiguration, isCentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import type { CliContext } from "./context.js";
import type { RunScaffold } from "./run-command.js";
import { tryloHome } from "./session-paths.js";
import { centralRuntimeLaunchFor } from "./central-runtime-control.js";
import { isProviderWaitDescriptor, type ProviderWaitDescriptor } from "../../learning/central/runtime/provider-positive.js";

/** A normal turn borrows the same owner, including when activation happened in an earlier process. */
export async function openCentralRuntimeForTurn(ctx: CliContext, scaffold: RunScaffold, signal?: AbortSignal) {
  if (scaffold.centralLearningOnlyIssueId !== undefined || scaffold.centralRuntimePolicy === "pause" || scaffold.centralRuntimePolicy === "stop") return undefined;

  const homeRoot = path.resolve(ctx.cwd, tryloHome(ctx.homeDir, ctx.env));
  const requestedRoot = scaffold.workspaceIdentity?.requestedRoot ?? scaffold.workspaceRoot;
  const primary = runtimeScopePaths(homeRoot, scaffold.workspaceIdentity?.workspaceRoot ?? scaffold.workspaceRoot);
  const requested = runtimeScopePaths(homeRoot, requestedRoot);
  // Only spellings with this mechanical key may accompany its read notifications.
  const sameKey = requested.scopeKey === primary.scopeKey;
  const paths = sameKey ? requested : primary, stored = readRuntimeIntent(paths);
  const sourceWorkspaceRoots = sameKey ? { sourceWorkspaceRoots: [requestedRoot] } : {};
  const warn = (reason: string) => ctx.stderr(`warning: ${reason}; original task remains available\n`);

  if (!stored.ok) {
    warn(stored.reason);
    return undefined;
  }

  // A saved stop is a user action, not absence of a setting. Ordinary repeated Desktop flags cannot undo it.
  if (stored.value?.enabled === false) return undefined;

  const configuration = stored.value?.configuration ?? centralRuntimeConfiguration(scaffold);
  if (configuration === undefined) {
    if (scaffold.centralLearning !== undefined) warn("runtime_endpoint_public_connection_required");
    return undefined;
  }

  if (!isCentralRuntimeConfiguration(configuration)) {
    warn("runtime_configuration_invalid");
    return undefined;
  }

  const attached = await attachCentralRuntime({ homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
    configuration: { ...configuration }, activation: "ordinary" }, await centralRuntimeLaunchFor(ctx, paths.workspaceRoot),
  signal === undefined ? {} : { signal });
  if (!attached.ok) {
    warn(attached.reason);
    return undefined;
  }

  const initial = await attached.client.wake({ reason: "normal_entry", sourceRefs: [], ...sourceWorkspaceRoots }, undefined, signal);
  if (!initial.ok) warn(initial.reason);

  // Reuse the existing owner's original-prefix reply. No journal/Board scan,
  // status probe or receipt reconstruction is added to the business turn.
  const observed = initial.ok ? initial.snapshot.progress?.providerWait : undefined;
  const providerWait = isProviderWaitDescriptor(observed) && observed.scope === paths.workspaceRoot ? observed : undefined;

  return { client: attached.client, allowance: configuration.allowance,
    ...(providerWait === undefined ? {} : { providerWait }),
    ...(configuration.thoughtMaxTokens === undefined ? {} : { thoughtMaxTokens: configuration.thoughtMaxTokens }),

    async afterTask(sessionId: string, turnId: string) {
      const result = await attached.client.wake({ reason: "normal_task_source_committed",
        sourceRefs: [sessionContentAddress({ sessionId, turnId })], ...sourceWorkspaceRoots });
      if (!result.ok) warn(result.reason);
    },

    close: () => attached.client.detach(),
  };
}

export type CentralRuntimeTurn = NonNullable<Awaited<ReturnType<typeof openCentralRuntimeForTurn>>>;

export type CentralRuntimeTurnScaffold = RunScaffold & { readonly centralRuntime?: CentralRuntimeClient;
  readonly centralProviderWait?: ProviderWaitDescriptor };
