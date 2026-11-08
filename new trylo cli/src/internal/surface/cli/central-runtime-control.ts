import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachCentralRuntime, type CentralRuntimeAttachment } from "../../adapters/central-learning-runtime/client.js";
import { readRuntimeIntent, readRuntimeLocator, runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import { requestCentralRuntime } from "../../adapters/central-learning-runtime/transport.js";
import type { CentralRuntimeLaunch } from "../../adapters/central-learning-runtime/launch.js";
import type { CentralRuntimeReply, CentralRuntimeSnapshot } from "../../adapters/central-learning-runtime/contracts.js";
import { isCentralRuntimeConfiguration, type CentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import type { CliContext } from "./context.js";
import { tryloHome } from "./session-paths.js";
import { canonicalRuntimeRoot, runtimePathIdentity, runtimeRecoveryState } from "../../adapters/central-learning-runtime/files-contract.js";
import { resolveCentralRuntimeWorkspaceIdentity } from "./central-runtime-workspace-identity.js";

export type CentralRuntimePolicy = "stop" | "pause" | "resume";

export type CentralRuntimeControlResult = { readonly ok: true; readonly enabled: boolean; readonly owner?: CentralRuntimeSnapshot;
  readonly configuration?: CentralRuntimeConfiguration;
  readonly recoveryPolicy?: "eligible" | "paused" | "legacy_unclassified"; readonly paused?: boolean }
  | { readonly ok: false; readonly reason: string };

export async function centralRuntimeLaunchFor(ctx: CliContext, workspaceRoot: string): Promise<CentralRuntimeLaunch> {
  let native = ctx.workspaceIdentity;
  if (native === undefined || !native.compatibleRoots.some(root => runtimePathIdentity(root) === runtimePathIdentity(workspaceRoot))) {
    const resolved = await resolveCentralRuntimeWorkspaceIdentity(ctx, workspaceRoot, { allowBudgetLookup: false });
    native = resolved.ok ? resolved.value : undefined;
  }

  const scope = canonicalRuntimeRoot(workspaceRoot);
  const workspaceLocation = native !== undefined && runtimePathIdentity(native.physicalRoot) !== runtimePathIdentity(scope)
    ? { scope, physicalRoot: native.physicalRoot, workspaceId: native.workspaceId } : undefined;

  return { executable: ctx.nodeExecutable ?? "node",
    entrypoint: fileURLToPath(new URL("../../../cmd/trylo/central-runtime-main.js", import.meta.url)), environment: ctx.env,
    ...(workspaceLocation === undefined ? {} : { workspaceLocation }) };
}

/** A newly launched owner already accepted one durable recovery/pending wake.
 * Confirmation does not wait for asynchronous initialization or semantic work. */
export async function resumeAttachedCentralRuntime(attached: Extract<CentralRuntimeAttachment, { readonly ok: true }>): Promise<CentralRuntimeReply> {
  if (attached.ownerSource !== "launched") return attached.client.wake({ reason: "explicit_runtime_resume", sourceRefs: [] });

  const reply = attached.initial;
  if (!reply.ok) return reply;

  const state = reply.snapshot;
  if (state.ownerId !== attached.client.ownerId || state.scopeKey !== attached.client.scopeKey) return { ok: false, reason: "runtime_owner_lost" };

  if (state.state === "failed") return { ok: false, reason: state.reason ?? "runtime_drive_failed" };

  if (state.state === "stopping" || state.state === "stopped") return { ok: false, reason: "runtime_stopping" };

  if (state.wakeSequence === 0) return { ok: false, reason: "runtime_start_unconfirmed" };

  return reply;
}

/** Works without a business turn. stop persists; privacy pause cancels this owner while retaining its restart intent. */
export async function controlCentralRuntimeFor(ctx: CliContext, workspaceRoot: string,
  operation: CentralRuntimePolicy | "inspect" | "restart"): Promise<CentralRuntimeControlResult> {
  const paths = runtimeScopePaths(path.resolve(ctx.cwd, tryloHome(ctx.homeDir, ctx.env)), workspaceRoot);
  const observed = (owner: CentralRuntimeSnapshot): CentralRuntimeControlResult => {
    const latest = readRuntimeIntent(paths);
    return latest.ok ? { ok: true, enabled: latest.value?.enabled === true, owner, ...runtimeRecoveryState(latest.value) }
      : { ok: false, reason: "runtime_control_readback_unconfirmed" };
  };
  const intent = readRuntimeIntent(paths), locator = readRuntimeLocator(paths);
  if (!intent.ok) return intent;
  if (!locator.ok) return locator;

  const current = locator.value === undefined ? undefined : await requestCentralRuntime(locator.value, { operation: "status" });

  if (operation === "inspect") return { ok: true, enabled: intent.value?.enabled === true,
    ...runtimeRecoveryState(intent.value),
    ...(isCentralRuntimeConfiguration(intent.value?.configuration) ? { configuration: intent.value.configuration } : {}),
    ...(current?.ok ? { owner: current.snapshot } : {}) };

  if (operation !== "resume" && current?.ok && locator.value !== undefined) {
    const result = await requestCentralRuntime(locator.value, { operation: "stop", mode: operation });
    return result.ok ? observed(result.snapshot) : result;
  }

  if (intent.value === undefined) return operation === "resume" ? { ok: false, reason: "runtime_not_enabled" }
    : { ok: true, enabled: false, ...runtimeRecoveryState(undefined) };

  if (operation === "pause" || operation === "restart") {
    // Refuse an unresponsive live owner instead of pretending privacy cancelled its in-flight inference.
    const lease = tryAcquireRuntimeOwner(paths);
    if (!lease.ok) return lease;

    try {
      const latest = readRuntimeIntent(paths);
      if (!latest.ok) return latest;
      if (latest.value === undefined) return { ok: true, enabled: false, ...runtimeRecoveryState(undefined) };
      const next = operation === "pause" ? { ...latest.value, recoveryPolicy: "paused" as const } : latest.value;
      if (operation === "pause") {
        const saved = lease.value.writeIntent(next);
        if (!saved.ok) return saved;
      }
      return { ok: true, enabled: next.enabled, ...runtimeRecoveryState(next) };
    } finally { lease.value.close(); }
  }

  if (operation === "resume" && current?.ok && locator.value !== undefined) {
    const classified = await requestCentralRuntime(locator.value, { operation: "activate" });
    if (!classified.ok) return classified;
    const result = await requestCentralRuntime(locator.value, { operation: "wake", wake: { reason: "explicit_runtime_resume", sourceRefs: [] } });
    return result.ok ? observed(result.snapshot) : result;
  }

  const lease = tryAcquireRuntimeOwner(paths);
  if (!lease.ok) return lease;

  let configuration = intent.value.configuration;
  let recovery = runtimeRecoveryState(intent.value);

  try {
    const latest = readRuntimeIntent(paths);
    if (!latest.ok) return latest;

    if (latest.value === undefined) return { ok: false, reason: "runtime_intent_missing" };

    configuration = latest.value.configuration;
    const saved = lease.value.writeIntent({ ...latest.value, enabled: operation === "resume",
      ...(operation === "resume" ? { recoveryPolicy: "eligible" as const } : {}) });
    if (!saved.ok) return saved;

    recovery = runtimeRecoveryState(operation === "resume" ? { recoveryPolicy: "eligible" } : latest.value);
  } finally { lease.value.close(); }

  if (operation === "stop") return { ok: true, enabled: false, ...recovery };

  if (!isCentralRuntimeConfiguration(configuration)) return { ok: false, reason: "runtime_configuration_invalid" };

  const attached = await attachCentralRuntime({ homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
    configuration, activation: "ordinary" }, await centralRuntimeLaunchFor(ctx, paths.workspaceRoot));
  if (!attached.ok) return attached;

  try { const state = await resumeAttachedCentralRuntime(attached);
    return state.ok ? observed(state.snapshot) : state;
  } finally { attached.client.detach(); }
}
