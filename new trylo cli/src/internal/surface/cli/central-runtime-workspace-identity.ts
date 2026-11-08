import path from "node:path";
import { readRuntimeIntent, runtimeScopePaths } from "../../adapters/central-learning-runtime/files.js";
import { canonicalRuntimeRoot, type RuntimeFileFailure, type RuntimeIntent } from "../../adapters/central-learning-runtime/files-contract.js";
import type { CentralLearningBudget, CentralLearningBudgetRootRef } from "../../learning/control/central-budget-contract.js";
import { isCentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import type { CliContext } from "./context.js";
import { methodBoardRoot } from "./learning-sink.js";
import { isValidSessionId, sessionPath, tryloHome } from "./session-paths.js";
import { workspaceIdentity } from "./workspace-identity.js";

export type CentralRuntimeWorkspaceIdentity = {
  readonly physicalRoot: string;
  /** Observed caller spelling; optional only for pre-existing injected descriptors. */
  readonly requestedRoot?: string;
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly budgetScope: string;
  readonly compatibleRoots: readonly string[];
  readonly compatibleWorkspaceIds: readonly string[];
  readonly rootRef?: CentralLearningBudgetRootRef;
  /** Explicit resume keeps its original business journal identity without rebinding the runtime. */
  readonly resumedSession?: { readonly workspaceRoot: string; readonly workspaceId: string };
};

type IdentityFailure = RuntimeFileFailure | "runtime_workspace_root_unavailable" | "runtime_workspace_root_mismatch"
  | "runtime_workspace_identity_unresolved" | "runtime_workspace_budget_conflict" | "runtime_workspace_budget_unavailable"
  | "runtime_configuration_invalid";

export type CentralRuntimeWorkspaceIdentityResult = { readonly ok: true; readonly value: CentralRuntimeWorkspaceIdentity }
  | { readonly ok: false; readonly reason: IdentityFailure; readonly detail?: string };

/** Reuse witnessed native identities; physical aliases grant read compatibility, never another funding root. */
export async function resolveCentralRuntimeWorkspaceIdentity(ctx: CliContext, requestedRoot: string,
  options: { readonly allowBudgetLookup: boolean; readonly resumeSessionId?: string }): Promise<CentralRuntimeWorkspaceIdentityResult> {
  if (!absoluteRoot(requestedRoot)) return { ok: false, reason: "runtime_workspace_root_unavailable" };

  const physicalRoot = physicalPath(ctx, requestedRoot);
  if (physicalRoot === undefined) return { ok: false, reason: "runtime_workspace_root_unavailable" };

  const samePhysical = (candidate: string) => absoluteRoot(candidate) && (candidate === requestedRoot
    || ctx.realPath !== undefined && physicalPath(ctx, candidate) === physicalRoot);
  const homeRoot = path.resolve(ctx.cwd, tryloHome(ctx.homeDir, ctx.env));
  const intent = savedIntent(homeRoot, requestedRoot, physicalRoot);
  if (!intent.ok) return intent;

  const saved = intent.value;
  if (saved !== undefined && !samePhysical(saved.workspaceRoot)) return { ok: false, reason: "runtime_workspace_root_mismatch" };

  const configuration = saved?.configuration;
  if (configuration !== undefined && !isCentralRuntimeConfiguration(configuration)) return { ok: false, reason: "runtime_configuration_invalid" };

  let rootRef = configuration?.rootRef;
  if (rootRef !== undefined && !samePhysical(rootRef.scope)) return { ok: false, reason: "runtime_workspace_root_mismatch" };

  const roots = new Set<string>();
  const witness = (root: string | undefined) => { if (root !== undefined && samePhysical(root)) roots.add(root); };

  witness(saved?.workspaceRoot);
  witness(rootRef?.scope);
  witness(requestedRoot);
  witness(ctx.cwd);
  witness(physicalRoot);

  // The original reader is loaded only for explicit activation or missing-reference recovery.
  if (rootRef === undefined && options.allowBudgetLookup) {
    const { createBoardReader } = await import("../../adapters/learning-store/file-event-store.js");
    const loaded = await createBoardReader(methodBoardRoot(ctx.homeDir, ctx.env)).load();
    if (!loaded.ok) return { ok: false, reason: "runtime_workspace_budget_unavailable", detail: loaded.reason };

    const matches = (loaded.state.centralLearningBudgets ?? []).filter(root => samePhysical(root.scope));
    if (matches.length > 1) return { ok: false, reason: "runtime_workspace_budget_conflict" };

    const original = matches[0];
    if (original !== undefined) {
      rootRef = budgetReference(original);
      witness(original.scope);
    }
  }

  const resume = options.resumeSessionId !== undefined
    ? await resumeIdentityRoot(ctx, options.resumeSessionId, roots, samePhysical) : undefined;
  if (resume !== undefined && !resume.ok) return resume;

  witness(resume?.root);
  const workspaceRoot = configuration === undefined ? resume?.root ?? rootRef?.scope ?? physicalRoot
    : [...roots].find(root => workspaceIdentity(root) === configuration.workspaceId);
  if (workspaceRoot === undefined) return { ok: false, reason: "runtime_workspace_identity_unresolved" };

  const compatibleRoots = [workspaceRoot, ...[...roots].filter(root => root !== workspaceRoot)];

  return { ok: true, value: { physicalRoot, requestedRoot, workspaceRoot, workspaceId: configuration?.workspaceId ?? workspaceIdentity(workspaceRoot),
    budgetScope: rootRef?.scope ?? workspaceRoot, compatibleRoots,
    compatibleWorkspaceIds: [...new Set(compatibleRoots.map(workspaceIdentity))], ...(rootRef === undefined ? {} : { rootRef }),
    ...(resume === undefined ? {} : { resumedSession: { workspaceRoot: resume.root, workspaceId: resume.workspaceId } }) } };
}

async function resumeIdentityRoot(ctx: CliContext, sessionId: string, roots: ReadonlySet<string>, samePhysical: (root: string) => boolean) {
  const unresolved = (detail: string) => ({ ok: false as const, reason: "runtime_workspace_identity_unresolved" as const, detail });

  if (!isValidSessionId(sessionId)) return unresolved("invalid_resume_session_id");

  const { readRuntimeSessionHeader } = await import("../../adapters/central-learning-runtime/session-header.js");
  const header = await readRuntimeSessionHeader(sessionPath(ctx.homeDir, ctx.env, sessionId), sessionId, new AbortController().signal);
  if (!header.ok) return unresolved(header.reason);

  const root = header.value.workspaceRoot ?? [...roots].find(candidate => workspaceIdentity(candidate) === header.value.workspaceId);
  if (root === undefined || workspaceIdentity(root) !== header.value.workspaceId || !samePhysical(root)) return unresolved("resume_workspace_identity_unproven");

  return { ok: true as const, root, workspaceId: header.value.workspaceId };
}

function physicalPath(ctx: CliContext, root: string): string | undefined {
  try {
    if (ctx.realPath === undefined) return absoluteRoot(root) ? root : undefined;
    const physical = ctx.realPath(root);
    return physical !== undefined && absoluteRoot(physical) ? canonicalRuntimeRoot(physical) : undefined;
  } catch { return undefined; } // Failed filesystem evidence never authorizes an alias.
}

function absoluteRoot(root: string): boolean {
  try {
    canonicalRuntimeRoot(root);
    return true;
  }
  catch { return false; } // Board semantic scopes and invalid roots are not filesystem identities.
}

function savedIntent(homeRoot: string, requestedRoot: string, physicalRoot: string) {
  let saved: RuntimeIntent | undefined;
  const keys = new Set<string>();

  for (const root of [requestedRoot, physicalRoot]) {
    const paths = runtimeScopePaths(homeRoot, root);
    if (keys.has(paths.scopeKey)) continue;

    keys.add(paths.scopeKey);
    const read = readRuntimeIntent(paths);
    if (!read.ok) return read;

    if (read.value === undefined) continue;

    if (saved !== undefined) return { ok: false as const, reason: "runtime_workspace_budget_conflict" as const };

    saved = read.value;
  }

  return { ok: true as const, value: saved };
}

function budgetReference(budget: CentralLearningBudget): CentralLearningBudgetRootRef {
  return { budgetId: budget.budgetId, scope: budget.scope, openedSequence: budget.openedSequence, authorizationRef: budget.authorizationRef };
}
