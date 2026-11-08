import path from "node:path";
import { readRuntimeIntent, runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { fields, identity } from "../../validation/json-shape.js";
import { isReasoningEffort, type ReasoningEffort } from "../../ports/provider.js";
import type { CliContext } from "./context.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { runCredentialFor } from "./provider-selection.js";
import { centralRuntimeProvider } from "./central-runtime-provider.js";
import { isCentralRuntimeConfiguration, type CentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import { isPublicCentralRuntimeEndpoint } from "./central-runtime-endpoint.js";
import { controlCentralRuntimeFor, type CentralRuntimeControlResult } from "./central-runtime-control.js";
import { tryloHome } from "./session-paths.js";
import { attachCentralRuntime } from "../../adapters/central-learning-runtime/client.js";
import { centralRuntimeLaunchFor } from "./central-runtime-control.js";
import { isCentralThoughtMaxTokens } from "../../learning/central/runtime/validation.js";
import { runtimeRecoveryState } from "../../adapters/central-learning-runtime/files-contract.js";
import { releaseLock, tryAcquireLock, type LockHandle } from "../../adapters/learning-store/lock.js";
import { isCentralGenerationLimits, type CentralGenerationLimits } from "../../learning/central/runtime/generation.js";

export type CentralRuntimeConfigurationPatch = { readonly userLearning?: boolean; readonly thoughtMaxTokens?: number | null;
  readonly generationLimits?: CentralGenerationLimits | null; readonly connection?: {
  readonly providerId: string; readonly model?: string; readonly endpoint?: string; readonly reasoningEffort?: ReasoningEffort | null;
} };

export function isCentralRuntimeConfigurationPatch(value: unknown): value is CentralRuntimeConfigurationPatch {
  if (!fields(value, ["userLearning", "connection", "thoughtMaxTokens", "generationLimits"].filter(key => typeof value === "object" && value !== null && key in value))) return false;

  if (value.userLearning !== undefined && typeof value.userLearning !== "boolean") return false;

  if (value.thoughtMaxTokens !== undefined && value.thoughtMaxTokens !== null && !isCentralThoughtMaxTokens(value.thoughtMaxTokens)) return false;

  if (Object.hasOwn(value, "generationLimits") && value.generationLimits !== null && !isCentralGenerationLimits(value.generationLimits)) return false;

  const connection = value.connection;
  if (connection === undefined) return typeof value.userLearning === "boolean" || value.thoughtMaxTokens === null || isCentralThoughtMaxTokens(value.thoughtMaxTokens)
    || value.generationLimits === null || isCentralGenerationLimits(value.generationLimits);

  return fields(connection, ["providerId", ...["model", "endpoint", "reasoningEffort"].filter(key => typeof connection === "object" && connection !== null && key in connection)])
    && identity(connection.providerId) && (connection.model === undefined || identity(connection.model))
    && (connection.endpoint === undefined || isPublicCentralRuntimeEndpoint(connection.endpoint))
    && (connection.reasoningEffort === undefined || connection.reasoningEffort === null || typeof connection.reasoningEffort === "string" && isReasoningEffort(connection.reasoningEffort));
}

/** Explicit settings handoff only. Per-turn flags never call this function.
 * The latest stop, rootRef and cumulative accounting survive it. */
export async function reconfigureCentralRuntimeFor(ctx: CliContext, workspaceRoot: string, patch: CentralRuntimeConfigurationPatch,
  options: { readonly signal?: AbortSignal; readonly sleep?: (milliseconds: number) => Promise<void> } = {}):
Promise<CentralRuntimeControlResult & { readonly configuration?: CentralRuntimeConfiguration }> {
  if (!isCentralRuntimeConfigurationPatch(patch)) return { ok: false, reason: "runtime_configuration_patch_invalid" };

  // Snapshot the flat validated policy before the asynchronous owner handoff.
  const generationLimits = patch.generationLimits == null ? patch.generationLimits : { ...patch.generationLimits };
  const paths = runtimeScopePaths(path.resolve(ctx.cwd, tryloHome(ctx.homeDir, ctx.env)), workspaceRoot);
  const original = readRuntimeIntent(paths);
  if (!original.ok) return original;

  if (original.value === undefined) return { ok: false, reason: "runtime_not_enabled" };

  if (!isCentralRuntimeConfiguration(original.value.configuration)) return { ok: false, reason: "runtime_configuration_invalid" };

  let connection: Pick<CentralRuntimeConfiguration, "providerId" | "model" | "endpointHash" | "endpoint" | "accountId" | "reasoningEffort"> | undefined;
  if (patch.connection !== undefined) {
    const chosen = patch.connection;
    const resolved = resolveConnectionSettings(ctx, { message: [], readStdin: false, provider: chosen.providerId,
      ...(chosen.model === undefined ? {} : { model: chosen.model }), ...(chosen.endpoint === undefined ? {} : { endpoint: chosen.endpoint }) });
    if ("exitCode" in resolved) return { ok: false, reason: "runtime_provider_configuration_unavailable" };

    const selected = resolved.provider, credential = runCredentialFor(ctx, selected.kind, selected.accountId);
    if ("exitCode" in credential) return { ok: false, reason: "runtime_provider_credential_unavailable" };

    if (chosen.endpoint !== undefined && !isPublicCentralRuntimeEndpoint(selected.endpoint, credential.apiKey)) {
      return { ok: false, reason: "runtime_endpoint_public_connection_required" };
    }

    connection = { providerId: selected.providerId, model: selected.model, endpointHash: contentHashOf(selected.endpoint),
      // A named provider remains the original address owner unless the user explicitly chose an override.
      ...(chosen.endpoint === undefined ? {} : { endpoint: selected.endpoint }),
      ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
      ...(chosen.reasoningEffort == null ? {} : { reasoningEffort: chosen.reasoningEffort }) };
    const { endpoint: _oldEndpoint, accountId: _oldAccount, reasoningEffort: _oldEffort, ...base } = original.value.configuration;
    const candidate = { ...base, ...connection };
    const checked = centralRuntimeProvider(ctx, candidate);
    if (!checked.ok) return checked;

    if (!checked.capabilities.tools) return { ok: false, reason: "central_deliberation_output_capability_unavailable" };

    if (!isCentralRuntimeConfiguration(candidate)) return { ok: false, reason: "runtime_configuration_invalid" };
  }

  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let startup: LockHandle | undefined;

  for (let attempt = 0; attempt < 50; attempt++) {
    if (options.signal?.aborted) return { ok: false, reason: "runtime_configuration_aborted" };

    const acquired = tryAcquireLock(path.join(paths.directory, "startup.lock"));
    if ("ok" in acquired) {
      if (acquired.reason !== "multi_writer") return { ok: false, reason: "runtime_io_failed" };
      await sleep(100);
      continue;
    }

    startup = acquired;
    break;
  }

  if (startup === undefined) return { ok: false, reason: "runtime_configuration_handoff_pending" };

  let publication: { readonly configuration: CentralRuntimeConfiguration; readonly enabled: boolean;
    readonly recovery: ReturnType<typeof runtimeRecoveryState> } | undefined;

  try {
    // Keep cold recover/ordinary launchers out of the gap between retiring the
    // old owner and publishing the new configuration. stop/pause still own
    // their existing owner lease and can win while this drain is in progress.
    const paused = await controlCentralRuntimeFor(ctx, workspaceRoot, "restart");
    if (!paused.ok) return paused;

    for (let attempt = 0; attempt < 50; attempt++) {
      if (options.signal?.aborted) return { ok: false, reason: "runtime_configuration_aborted" };

      const lease = tryAcquireRuntimeOwner(paths);
      if (!lease.ok) {
        if (lease.reason !== "runtime_owner_busy") return lease;
        await sleep(100);
        continue;
      }

      try {
        const latest = readRuntimeIntent(paths);
        if (!latest.ok) return latest;

        if (latest.value === undefined || !isCentralRuntimeConfiguration(latest.value.configuration)) return { ok: false, reason: "runtime_configuration_invalid" };

        const current = latest.value.configuration;
        const { endpoint: _endpoint, accountId: _account, reasoningEffort: _effort, providerId: _provider, model: _model, endpointHash: _hash, ...rest } = current;
        let next = { ...(connection === undefined ? current : { ...rest, ...connection }),
          ...(patch.userLearning === undefined ? {} : { userLearning: patch.userLearning }) };

        if (patch.thoughtMaxTokens === null) {
          const { thoughtMaxTokens: _thought, ...legacy } = next;
          next = legacy;
        } else if (patch.thoughtMaxTokens !== undefined) next = { ...next, thoughtMaxTokens: patch.thoughtMaxTokens };

        if (generationLimits === null) {
          const { generationLimits: _generation, ...legacy } = next;
          next = legacy;
        } else if (generationLimits !== undefined) next = { ...next, generationLimits };

        const saved = lease.value.writeIntent({ ...latest.value, configuration: next });
        if (!saved.ok) return saved;

        publication = { configuration: next, enabled: latest.value.enabled, recovery: runtimeRecoveryState(latest.value) };
      } finally { lease.value.close(); }

      break;
    }
  } finally { releaseLock(startup); }

  if (publication === undefined) return { ok: false, reason: "runtime_configuration_handoff_pending" };

  const { configuration: next, enabled, recovery } = publication;

  if (!enabled || recovery.paused) return { ok: true, enabled, configuration: next, ...recovery };

  // Attach takes the same startup lease, so publication must release it first.
  const attached = await attachCentralRuntime({ homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
    configuration: next, activation: "preserve" }, await centralRuntimeLaunchFor(ctx, paths.workspaceRoot), options.signal === undefined ? {} : { signal: options.signal });
  if (!attached.ok) {
    if (attached.reason === "runtime_disabled") return { ok: true, enabled: false, configuration: next };
    if (attached.reason === "runtime_paused") return { ok: true, enabled, configuration: next, recoveryPolicy: "paused", paused: true };
    return attached;
  }

  try {
    const woke = await attached.client.wake({ reason: "explicit_runtime_configuration_changed", sourceRefs: [] });
    return woke.ok ? { ok: true, enabled: true, owner: woke.snapshot, configuration: next, ...runtimeRecoveryState(woke.snapshot) } : woke;
  } finally { attached.client.detach(); }
}
