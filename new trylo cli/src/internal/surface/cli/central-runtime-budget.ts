import path from "node:path";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { readRuntimeIntent, runtimeScopePaths } from "../../adapters/central-learning-runtime/files.js";
import { setCentralLearningBudgetLimitAtRoot } from "../../integration/learning-content/central-accounting-management.js";
import { centralBudgetChangeSourceRef } from "../../integration/central-learning/runtime-budget-source.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import type { CentralLearningBudgetRootRef } from "../../learning/control/central-budget-contract.js";
import { sameCentralLearningResources } from "../../learning/control/central-learning-resources.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { BoardState } from "../../learning/control/state.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { isCentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import { readCentralRuntimeBudgetInput, type CentralRuntimeBudgetInput, type CentralRuntimeBudgetDependencies,
  type CentralRuntimeBudgetReply, type CentralRuntimeBudgetView, type CentralRuntimeBudgetWake } from "./central-runtime-budget-contract.js";
import { methodBoardRoot } from "./learning-sink.js";
import { resolveWorkspaceRoot } from "./run-workspace.js";
import { tryloHome } from "./session-paths.js";
import type { CliContext } from "./context.js";

export type { CentralRuntimeBudgetDependencies, CentralRuntimeBudgetReply } from "./central-runtime-budget-contract.js";

type Failure = { readonly ok: false; readonly reason: string };

type BudgetState = { readonly ok: true; readonly enabled: boolean; readonly board: BoardState; readonly view: CentralRuntimeBudgetView | null };

type SetLimitsInput = Extract<CentralRuntimeBudgetInput, { readonly action: "budget_set_limits" }>;

/** Explicit administrative command only. No provider, task prompt or runtime
 * activation is constructed; the canonical root remains the sole budget owner. */
export async function handleCentralRuntimeBudgetCommand(ctx: CliContext, value: unknown,
  dependencies: CentralRuntimeBudgetDependencies): Promise<ExitCode> {
  const input = readCentralRuntimeBudgetInput(value);
  if (input === undefined) return emit(ctx, { ok: false, reason: "central_runtime_budget_input_invalid" }, EXIT_CODES.USAGE);

  const scope = resolveWorkspaceRoot(ctx, input.workspaceRoot);
  if (typeof scope !== "string") return emit(ctx, { ok: false, reason: "workspace_unavailable" }, scope.exitCode);

  try {
    const current = await readBudgetState(ctx, scope, dependencies);
    if (!current.ok) return emit(ctx, current, EXIT_CODES.CONFIG);
    if (input.action === "budget_inspect") return emit(ctx, { ok: true, enabled: current.enabled, budget: current.view }, EXIT_CODES.OK);
    return await setLimits(ctx, scope, input, current, dependencies);
  } catch {
    // The original writer may already have committed. Report unconfirmed state;
    // only a same-change retry/readback can establish the result, never a new id.
    return emit(ctx, { ok: false, reason: "central_runtime_budget_unconfirmed" }, EXIT_CODES.CONFIG);
  }
}

async function setLimits(ctx: CliContext, scope: string, input: SetLimitsInput, current: BudgetState,
  dependencies: CentralRuntimeBudgetDependencies): Promise<ExitCode> {
  if (current.view === null || !sameRoot(input.rootRef, current.view.rootRef) || input.rootRef.scope !== scope) {
    return emit(ctx, { ok: false, reason: "learning_budget_binding" }, EXIT_CODES.CONFIG);
  }

  // Stable across process retries and refreshed CAS prefixes. The explicit user
  // command is the authorization source; a model/caller cannot inject that ref.
  const authorizationRef = `explicit-user-budget:${contentHashOf({ rootRef: input.rootRef, changeId: input.changeId, limits: input.limits })}`;
  const changed = await setCentralLearningBudgetLimitAtRoot({ boardRoot: methodBoardRoot(ctx.homeDir, ctx.env),
    issuedAt: new Date(ctx.now()).toISOString(), action: { kind: "set_budget_limit", budgetId: input.rootRef.budgetId,
      expectedSequence: input.expectedSequence, changeId: input.changeId, limits: input.limits, authorizationRef } });
  if (!changed.ok) return emit(ctx, { ok: false, reason: changed.reason }, EXIT_CODES.CONFIG);

  const readback = await readBudgetState(ctx, scope, dependencies);
  if (!readback.ok) {
    // A read refusal follows a confirmed writer result. It cannot retroactively
    // classify the original mutation as a pre-commit rejection.
    ctx.stderr(`central_runtime_budget_readback_unconfirmed:${readback.reason}\n`);
    return emit(ctx, { ok: false, reason: "central_runtime_budget_readback_unconfirmed" }, EXIT_CODES.CONFIG);
  }

  const change = readback.board.centralLearningBudgets?.find(root => root.budgetId === input.rootRef.budgetId)
    ?.limitChanges?.find(item => item.changeId === input.changeId);
  if (readback.view === null || !sameRoot(input.rootRef, readback.view.rootRef) || change?.authorizationRef !== authorizationRef
    || !sameCentralLearningResources(change.limits, input.limits)) {
    return emit(ctx, { ok: false, reason: "central_runtime_budget_readback_unconfirmed" }, EXIT_CODES.CONFIG);
  }

  // Board idempotence proves the limit change, not delivery of its source fact.
  // A same-change retry may be recovering a lost readback/notification/process;
  // re-notify the original enabled owner with the same stable change reference.
  const wake = await notifyBudgetChange(ctx, scope, input, dependencies);

  return emit(ctx, { ok: true, enabled: readback.enabled, budget: readback.view,
    mutation: changed.idempotent ? "duplicate" : "applied", wake }, EXIT_CODES.OK);
}

async function readBudgetState(ctx: CliContext, scope: string, dependencies: CentralRuntimeBudgetDependencies): Promise<BudgetState | Failure> {
  const saved = readSavedRuntime(ctx, scope);
  if (!saved.ok) return saved;

  const boardRoot = methodBoardRoot(ctx.homeDir, ctx.env);
  const loaded = await (dependencies.readBoard?.(boardRoot) ?? createBoardReader(boardRoot).load());
  if (!loaded.ok) return loaded;

  const root = loaded.state.centralLearningBudgets?.find(item => item.scope === scope);
  const projection = root === undefined ? undefined : centralBudgetProjection(loaded.state, root.budgetId);
  if (root !== undefined && projection === undefined) return { ok: false, reason: "central_learning_budget_unavailable" };

  if (saved.rootRef !== undefined && (projection === undefined || !sameRoot(saved.rootRef, projection.budget))) {
    return { ok: false, reason: "learning_budget_binding" };
  }

  const view: CentralRuntimeBudgetView | null = projection === undefined ? null : {
    rootRef: rootIdentity(projection.budget), boardSequence: loaded.state.sequence,
    limits: projection.budget.limits, occupied: projection.occupied, available: projection.available, status: projection.status,
    ...(projection.holdReason === undefined ? {} : { holdReason: projection.holdReason }),
  };

  return { ok: true, enabled: saved.enabled, board: loaded.state, view };
}

function readSavedRuntime(ctx: CliContext, scope: string): Failure | { readonly ok: true; readonly enabled: boolean;
  readonly rootRef?: CentralLearningBudgetRootRef } {
  const paths = runtimeScopePaths(path.resolve(ctx.cwd, tryloHome(ctx.homeDir, ctx.env)), scope);
  const saved = readRuntimeIntent(paths);
  if (!saved.ok) return saved;

  if (saved.value === undefined) return { ok: true, enabled: false };

  if (!isCentralRuntimeConfiguration(saved.value.configuration)) return { ok: false, reason: "runtime_configuration_invalid" };

  const rootRef = saved.value.configuration.rootRef;

  return { ok: true, enabled: saved.value.enabled, ...(rootRef === undefined ? {} : { rootRef }) };
}

async function notifyBudgetChange(ctx: CliContext, scope: string, input: SetLimitsInput,
  dependencies: CentralRuntimeBudgetDependencies): Promise<CentralRuntimeBudgetWake> {
  // Re-read after the Board commit. A saved stop or a different root must not be
  // turned into an activation by a generic source-notification transport.
  const saved = readSavedRuntime(ctx, scope);
  if (!saved.ok) return { status: "unconfirmed", reason: saved.reason };

  if (!saved.enabled) return { status: "skipped", reason: "runtime_not_enabled" };

  if (saved.rootRef === undefined || !sameRoot(saved.rootRef, input.rootRef)) return { status: "skipped", reason: "runtime_budget_binding_changed" };

  try {
    const result = await dependencies.notifyExistingEnabled({ ctx, workspaceRoot: scope, rootRef: input.rootRef,
      wake: { reason: "explicit_central_budget_limits_changed", sourceRefs: [input.rootRef.budgetId,
        centralBudgetChangeSourceRef(input.rootRef.budgetId, input.changeId)] } });
    return !result.ok ? { status: "unconfirmed", reason: result.reason }
      : result.notified ? { status: "sent" } : { status: "skipped", reason: "runtime_not_notified" };
  } catch {
    // Notification cannot reverse a confirmed cumulative limit change.
    return { status: "unconfirmed", reason: "runtime_notification_unavailable" };
  }
}

function rootIdentity(root: CentralLearningBudgetRootRef): CentralLearningBudgetRootRef {
  return { budgetId: root.budgetId, scope: root.scope, openedSequence: root.openedSequence, authorizationRef: root.authorizationRef };
}

function sameRoot(left: CentralLearningBudgetRootRef, right: CentralLearningBudgetRootRef): boolean {
  return left.budgetId === right.budgetId && left.scope === right.scope && left.openedSequence === right.openedSequence
    && left.authorizationRef === right.authorizationRef;
}

function emit(ctx: CliContext, reply: Omit<Extract<CentralRuntimeBudgetReply, { readonly ok: true }>, "schemaVersion" | "domain">
  | Omit<Extract<CentralRuntimeBudgetReply, { readonly ok: false }>, "schemaVersion" | "domain">, code: ExitCode): ExitCode {
  ctx.stdout(`${JSON.stringify({ schemaVersion: 1, domain: "central_runtime_budget", ...reply })}\n`);
  return code;
}
