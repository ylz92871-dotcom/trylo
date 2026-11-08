import path from "node:path";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { readRuntimeIntent, runtimeScopePaths } from "../../adapters/central-learning-runtime/files.js";
import { initialCentralRuntimeRef, readCentralRuntimeRecords, type CentralRuntimeRead } from "../../learning/central/runtime/records.js";
import type { CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { isContentDataSafe } from "../../integration/learning-content/content-confidentiality.js";
import { projectContentSourceText } from "../../integration/learning-content/sources/source-text-view.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { CliContext } from "./context.js";
import { methodBoardRoot } from "./learning-sink.js";
import { tryloHome } from "./session-paths.js";
import { resolveCentralRuntimeWorkspaceIdentity } from "./central-runtime-workspace-identity.js";

export const CENTRAL_OVERVIEW_LIMITS = Object.freeze({ intents: 8, work: 8, textChars: 160, residuals: 3, refs: 4 });

type OverviewOptions = { readonly signal?: AbortSignal; readonly secrets?: readonly string[] };

/** Public current checkpoint only. No source body, frame, User ledger or gain estimate is projected. */
export function projectCentralRuntimeOverview(read: CentralRuntimeRead, input: {
  readonly scopeKey: string; readonly observedAt: string; readonly intentEnabled: boolean; readonly secrets?: readonly string[];
}): JsonObject {
  const base = { schemaVersion: 1, scopeKey: input.scopeKey, observedAt: input.observedAt,
    boardRevision: read.revision, intentEnabled: input.intentEnabled };

  if (read.stateRef === initialCentralRuntimeRef(read.state.scope)) return { ...base, status: "no_checkpoint" };

  const secrets = input.secrets ?? [], scope = read.state.scope;
  const excerpt = (value: string) => {
    const publicText = projectContentSourceText({ ref: read.stateRef, runId: read.stateRef, sequence: read.revision,
      scope, origin: "model_proposal", text: value }, secrets).record.text;
    const characters = [...publicText];
    return { text: characters.slice(0, CENTRAL_OVERVIEW_LIMITS.textChars).join(""),
      truncated: characters.length > CENTRAL_OVERVIEW_LIMITS.textChars };
  };
  const references = (refs: readonly string[]) => ({ refs: refs.slice(0, CENTRAL_OVERVIEW_LIMITS.refs),
    omitted: Math.max(0, refs.length - CENTRAL_OVERVIEW_LIMITS.refs) });
  const continuation = (intent: CentralLearningIntentDraft): JsonObject => {
    const next = intent.continuation;
    if (next.kind === "ready") return { kind: "ready", interpretation: "committed_next_step_not_execution_receipt",
      operationId: next.operation.operationId, operation: next.operation.kind, purpose: excerpt(next.operation.purpose),
      expectedChange: excerpt(next.operation.expectedChange), sources: references(next.operation.sourceRefs) };

    if (next.kind === "waiting") return { kind: "waiting", wait: next.wait.kind, reason: excerpt(next.wait.reason),
      ...(next.wait.kind === "until" ? { at: next.wait.at } : {}), sources: references(next.wait.sourceRefs) };

    if (next.kind === "open") return { kind: "open", interpretation: "open_purpose_without_committed_successor" };

    return { kind: "ended", goalState: next.goalState };
  };
  const active = read.state.intents.filter(intent => intent.continuation.kind !== "ended");
  const privateUser = active.filter(intent => intent.subject.plane === "user"), visible = active.filter(intent => intent.subject.plane !== "user");
  const userIds = new Set(read.state.intents.filter(intent => intent.subject.plane === "user").map(intent => intent.intentId));
  const privateWork = (work: CentralRuntimeRead["state"]["running"][number]) => userIds.has(work.intentId) || work.frame.kind === "user_learning";
  const work = read.state.running.filter(row => !privateWork(row));
  const value: JsonObject = { ...base, status: "ready", headRef: read.stateRef,
    interpretation: "bounded_public_checkpoint_excerpt_not_source_body_or_live_execution_proof",
    counts: { active: active.length, publicIntents: visible.length, privateUserIntents: privateUser.length,
      recordedWork: read.state.running.length, privateUserWork: read.state.running.filter(privateWork).length },
    intents: visible.slice(0, CENTRAL_OVERVIEW_LIMITS.intents).map(intent => ({ intentId: intent.intentId,
      subject: intent.subject, goal: excerpt(intent.goal),
      residual: intent.residual.slice(0, CENTRAL_OVERVIEW_LIMITS.residuals).map(excerpt),
      omittedResiduals: Math.max(0, intent.residual.length - CENTRAL_OVERVIEW_LIMITS.residuals),
      continuation: continuation(intent), sources: references(intent.sourceRefs) })),
    omittedIntents: Math.max(0, visible.length - CENTRAL_OVERVIEW_LIMITS.intents),
    recordedWork: work.slice(0, CENTRAL_OVERVIEW_LIMITS.work).map(row => ({ workRef: row.workRef, intentId: row.intentId,
      operationId: row.operation.operationId, operation: row.operation.kind, purpose: excerpt(row.operation.purpose),
      sources: references(row.operation.sourceRefs), interpretation: "original_checkpoint_unresolved_work_not_live_process_status" })),
    omittedWork: Math.max(0, work.length - CENTRAL_OVERVIEW_LIMITS.work),
    privateUser: { active: privateUser.length, open: privateUser.filter(row => row.continuation.kind === "open").length,
      ready: privateUser.filter(row => row.continuation.kind === "ready").length,
      waiting: privateUser.filter(row => row.continuation.kind === "waiting").length,
      interpretation: "private_content_omitted_use_original_user_learning_reader" }, limits: CENTRAL_OVERVIEW_LIMITS };

  return isContentDataSafe(value, { scope }, secrets) ? value
    : { ...base, status: "unavailable", reason: "runtime_overview_public_projection_rejected" };
}

/** Explicit on-demand read. It never attaches/wakes an owner or creates a budget. */
export async function readCentralRuntimeOverviewFor(ctx: CliContext, workspaceRoot: string,
  options: OverviewOptions = {}): Promise<JsonObject> {
  const unavailable = (reason: string): JsonObject => ({ schemaVersion: 1, status: "unavailable", reason,
    observedAt: new Date(ctx.now()).toISOString() });
  const cancelled = () => options.signal?.aborted === true;
  if (cancelled()) return unavailable("runtime_overview_cancelled");

  try {
    const identity = await resolveCentralRuntimeWorkspaceIdentity(ctx, workspaceRoot, { allowBudgetLookup: false });
    if (!identity.ok) return unavailable(identity.reason);

    const paths = runtimeScopePaths(path.resolve(ctx.cwd, tryloHome(ctx.homeDir, ctx.env)), identity.value.workspaceRoot);
    const intent = readRuntimeIntent(paths);
    if (!intent.ok) return unavailable(intent.reason);

    if (intent.value === undefined) return { schemaVersion: 1, status: "not_configured", scopeKey: paths.scopeKey,
      observedAt: new Date(ctx.now()).toISOString() };

    if (cancelled()) return unavailable("runtime_overview_cancelled");

    // The existing validated identity owns this original budget scope. No alias/root search or historical body lookup.
    const loaded = await createBoardReader(methodBoardRoot(ctx.homeDir, ctx.env)).load();
    if (!loaded.ok) return unavailable(loaded.reason);

    if (cancelled()) return unavailable("runtime_overview_cancelled");

    const head = readCentralRuntimeRecords(loaded.state.rewardV2Facts ?? [], identity.value.budgetScope, loaded.state.sequence);

    return projectCentralRuntimeOverview(head, { scopeKey: paths.scopeKey, intentEnabled: intent.value.enabled,
      observedAt: new Date(ctx.now()).toISOString(), ...(options.secrets === undefined ? {} : { secrets: options.secrets }) });
  } catch {
    return unavailable("runtime_overview_checkpoint_unavailable");
  }
}
