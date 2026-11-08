import path from "node:path";
import { attachCentralRuntime } from "../../adapters/central-learning-runtime/client.js";
import { readRuntimeIntent, readRecoverableRuntimeScopes, runtimeScopePaths } from "../../adapters/central-learning-runtime/files.js";
import { runtimeRecoveryState } from "../../adapters/central-learning-runtime/files-contract.js";
import { isRuntimeActivationFailure } from "../../adapters/central-learning-runtime/launch.js";
import type { CentralRuntimeSnapshot } from "../../adapters/central-learning-runtime/contracts.js";
import { fields, identity } from "../../validation/json-shape.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { isCentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import { centralRuntimeLaunchFor } from "./central-runtime-control.js";
import { resolveWorkspaceRoot } from "./run-workspace.js";
import { tryloHome } from "./session-paths.js";
import type { CliContext } from "./context.js";

export type CentralRuntimeRecoveryResult = {
  readonly scopeKey: string; readonly workspaceRoot: string;
  readonly status: "existing" | "launched" | "skipped" | "error";
  readonly reason?: string; readonly enabled?: boolean;
  readonly recoveryPolicy?: "eligible" | "paused" | "legacy_unclassified";
  readonly paused?: boolean; readonly owner?: CentralRuntimeSnapshot;
};

type CentralRuntimeRecoveryPayload =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly action: "recover"; readonly result: CentralRuntimeRecoveryResult }
  | { readonly ok: true; readonly action: "recover_enabled"; readonly results: readonly CentralRuntimeRecoveryResult[];
      readonly issues: readonly { readonly scopeKey: string; readonly reason: string }[]; readonly nextCursor?: string };

export type CentralRuntimeRecoveryReply = { readonly schemaVersion: 1; readonly domain: "central_runtime_recovery" } & CentralRuntimeRecoveryPayload;

export type CentralRuntimeRecoveryDependencies = { readonly attach?: typeof attachCentralRuntime };

/** Continue existing authority only. No stop, configuration, budget, or wake is submitted. */
export async function recoverCentralRuntimeFor(ctx: CliContext, workspaceRoot: string,
  dependencies: CentralRuntimeRecoveryDependencies = {}): Promise<CentralRuntimeRecoveryResult> {
  const paths = runtimeScopePaths(path.resolve(ctx.cwd, tryloHome(ctx.homeDir, ctx.env)), workspaceRoot);
  const base = { scopeKey: paths.scopeKey, workspaceRoot: paths.workspaceRoot };
  const saved = readRuntimeIntent(paths);
  if (!saved.ok) return { ...base, status: "error", reason: saved.reason };

  const intent = saved.value, state = { enabled: intent?.enabled === true, ...runtimeRecoveryState(intent) };
  if (intent === undefined) return { ...base, ...state, status: "skipped", reason: "runtime_intent_missing" };

  if (!intent.enabled) return { ...base, ...state, status: "skipped", reason: "runtime_disabled" };

  if (intent.recoveryPolicy === "paused") return { ...base, ...state, status: "skipped", reason: "runtime_paused" };

  if (!isCentralRuntimeConfiguration(intent.configuration)) return { ...base, ...state, status: "error", reason: "runtime_configuration_invalid" };

  try {
    const attached = await (dependencies.attach ?? attachCentralRuntime)({ homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
      configuration: intent.configuration, activation: "recover" }, await centralRuntimeLaunchFor(ctx, paths.workspaceRoot));
    if (!attached.ok) {
      // The child may have observed a newer stop/pause than this command's first read.
      const latest = readRuntimeIntent(paths);
      const current = latest.ok ? { enabled: latest.value?.enabled === true, ...runtimeRecoveryState(latest.value) } : {};
      return { ...base, ...current, status: isRuntimeActivationFailure(attached.reason) ? "skipped" : "error", reason: attached.reason };
    }

    try {
      return attached.initial.ok ? { ...base, ...state, ...runtimeRecoveryState(attached.initial.snapshot),
        status: attached.ownerSource, owner: attached.initial.snapshot }
        : { ...base, ...state, status: "error", reason: attached.initial.reason };
    } finally { attached.client.detach(); }
  } catch { return { ...base, ...state, status: "error", reason: "runtime_recovery_unconfirmed" }; }
}

/** Paging counts scanned registered keys, including disabled or damaged entries. */
export async function handleCentralRuntimeRecoveryCommand(ctx: CliContext, input: unknown,
  dependencies: CentralRuntimeRecoveryDependencies = {}): Promise<ExitCode> {
  const emit = (value: CentralRuntimeRecoveryPayload, exitCode: ExitCode) => {
    ctx.stdout(`${JSON.stringify({ schemaVersion: 1, domain: "central_runtime_recovery", ...value })}\n`);
    return exitCode;
  };

  if (fields(input, ["workspaceRoot", "action"]) && input.action === "recover" && identity(input.workspaceRoot)) {
    const scope = resolveWorkspaceRoot(ctx, input.workspaceRoot);
    if (typeof scope !== "string") return emit({ ok: false, reason: "workspace_unavailable" }, scope.exitCode);
    const result = await recoverCentralRuntimeFor(ctx, scope, dependencies);
    return emit({ ok: true, action: "recover", result }, EXIT_CODES.OK);
  }

  if (!fields(input, ["action", ...["afterScopeKey", "limit"].filter(key => typeof input === "object" && input !== null && key in input)])
    || input.action !== "recover_enabled" || input.afterScopeKey !== undefined && (typeof input.afterScopeKey !== "string" || !/^[0-9a-f]{64}$/u.test(input.afterScopeKey))
    || input.limit !== undefined && (typeof input.limit !== "number" || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64)) {
    return emit({ ok: false, reason: "central_runtime_recovery_input_invalid" }, EXIT_CODES.USAGE);
  }

  const page = readRecoverableRuntimeScopes(path.resolve(ctx.cwd, tryloHome(ctx.homeDir, ctx.env)), {
    ...(input.afterScopeKey === undefined ? {} : { afterScopeKey: input.afterScopeKey }),
    ...(input.limit === undefined ? {} : { limit: input.limit }) });
  if (!page.ok) return emit({ ok: false, reason: page.reason }, EXIT_CODES.CONFIG);

  const results: CentralRuntimeRecoveryResult[] = [];

  for (const scope of page.value.scopes) results.push(await recoverCentralRuntimeFor(ctx, scope.workspaceRoot, dependencies));

  return emit({ ok: true, action: "recover_enabled", results, issues: page.value.issues,
    ...(page.value.nextCursor === undefined ? {} : { nextCursor: page.value.nextCursor }) }, EXIT_CODES.OK);
}
