import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args-primitives.js";
import type { RunScaffold } from "./run-command.js";
import type { WorkflowRunNomination } from "../../integration/workflow-learning/run-adoption.js";
import { createWorkflowModelPort } from "../../adapters/provider/workflow-worker.js";
import { buildProvider } from "./provider-build.js";
import { createDenyAllPermission } from "./permission.js";
import { workflowBoardRoot } from "./commands-workflow-learning.js";
import { readLegacyWorkflowCatalog } from "../../integration/workflow-learning/archive.js";
import { explicitWorkflowCorrections, recommendAutomaticWorkflow } from "../../integration/workflow-learning/recommendation.js";
import { observeWorkflowTurn, workflowObservationWatermark } from "../../integration/workflow-learning/raw-facts.js";
import { classifyAutomaticWorkflow, learnAutomaticWorkflow } from "../../integration/workflow-learning/automatic-runtime.js";
import { resolveActiveWorkflowAdoption } from "../../integration/workflow-learning/run-adoption.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { familiesFromVersions } from "../../integration/workflow-learning/known-families.js";
import { readLearnedWorkflowJobForTurn } from "../../integration/workflow-learning/automatic-jobs.js";
import type { WorkflowTask } from "../../learning/domains/workflow/trace-contracts.js";
import type { LegacyWorkflowContext } from "../../learning/agent/subsystems/workflow/runtime/legacy-guidance.js";

export type AutomaticWorkflow = { readonly nomination?: WorkflowRunNomination; readonly learningAllowanceRemaining?: number;
  readonly legacyContext?: LegacyWorkflowContext; close?(): Promise<void> };

/** Explicit opt-in, separate model allowance, no tools or permission authority. */
export async function openAutomaticWorkflow(ctx: CliContext, options: RunCommandOptions, scaffold: RunScaffold,
  promptText: string, signal: AbortSignal = new AbortController().signal,
  mode: "legacy_learning" | "adoption_only" | "normal_improvement" = "legacy_learning"): Promise<AutomaticWorkflow> {
  if (!options.workflowLearning || options.workflowCollection === "disabled" || scaffold.session === undefined || signal.aborted) return {};

  const warn = (code: string) => ctx.stderr(`warning: workflow_learning:${code}\n`);
  const unavailable = (code: string): AutomaticWorkflow => mode === "normal_improvement"
    ? { learningAllowanceRemaining: options.workflowLearningBudget ?? 16000, legacyContext: { kind: "unavailable", reason: code, corrections: [] } } : {};
  const provider = buildProvider({ providerId: scaffold.providerId, providerKind: scaffold.providerKind,
    model: scaffold.model, endpoint: scaffold.endpoint, apiKey: scaffold.apiKey, workspaceRoot: scaffold.workspaceRoot,
    ...(mode !== "legacy_learning" ? { requestAttemptPolicy: "single_request" as const } : {}),
    permission: createDenyAllPermission(), ...(scaffold.tokenManager === undefined ? {} : { tokenManager: scaffold.tokenManager }) });
  if ("code" in provider) {
    warn(provider.code);
    return unavailable(provider.code);
  }

  const model = createWorkflowModelPort({ provider, model: scaffold.model, allowance: options.workflowLearningBudget ?? 16000 });
  const boardRoot = workflowBoardRoot(ctx);
  const catalog = await readLegacyWorkflowCatalog(boardRoot);
  if (!catalog.ok) {
    warn(catalog.code);
    return unavailable(catalog.code);
  }

  const versions = catalog.value.providerVersions;
  const scope = workspaceIdentity(scaffold.workspaceRoot);
  const corrections = explicitWorkflowCorrections(catalog.value.versions, scope);
  const effectiveCorrections = corrections.filter(item => item.visibility === undefined || item.visibility === "available");
  const knownFamilies = familiesFromVersions(versions, scope);
  const families = mode !== "normal_improvement" ? knownFamilies : [...knownFamilies, ...effectiveCorrections.map(item => ({ ...item.task,
    conditions: { ...item.task.conditions, ...item.correction.when } }))];
  const context = { boardRoot, model, allowance: options.workflowLearningBudget ?? 16000, now: () => new Date(ctx.now()).toISOString() };
  const active = await resolveActiveWorkflowAdoption(boardRoot, scaffold.resumeRecords ?? []);
  if (!active.ok) {
    warn(active.code);
    return unavailable(active.code);
  }

  let task: WorkflowTask | undefined = active.value?.task;
  let spent = 0;

  if (task === undefined && !(mode === "normal_improvement" && options.workflowVersion !== undefined)
    && (versions.some(item => item.artifact.scope === scope && item.artifact.mode === "path")
      || mode === "normal_improvement" && effectiveCorrections.length > 0)) {
    const classified = await classifyAutomaticWorkflow(context, { text: promptText.slice(0, 12000), scope, families,
      sessionId: scaffold.sessionId, watermark: scaffold.resumeRecords?.at(-1)?.sequence ?? 0 }, signal);
    spent = mode !== "legacy_learning" ? model.usage().tokens : classified.ok ? classified.value.spent : context.allowance;
    if (!classified.ok) warn(classified.code);
    else if (classified.value.kind === "classified") task = classified.value.task;
    else warn(classified.value.code);
  }

  const recommended = task === undefined ? undefined : recommendAutomaticWorkflow(versions, task);
  let nomination: WorkflowRunNomination | undefined = active.value;
  if (mode !== "normal_improvement" && nomination === undefined && task !== undefined && recommended?.nomination !== undefined) {
    nomination = { versionId: recommended.nomination.versionId, task,
      conditionEvidenceRefs: [`session:${scaffold.sessionId}/input`] };
  }

  let parent = nomination?.versionId ?? recommended?.learningParent?.versionId;
  const historicalReference = recommended?.nomination ?? recommended?.learningParent;
  const legacyBase = { corrections, ...(task === undefined ? {} : { hostTask: task }),
    ...(historicalReference === undefined ? {} : { reference: historicalReference }) };
  const pinnedVersion = active.value?.versionId ?? options.workflowVersion;
  const legacyContext: LegacyWorkflowContext = pinnedVersion === undefined ? { ...legacyBase, kind: "reference" }
    : { ...legacyBase, kind: "pinned", versionId: pinnedVersion };
  let closed = false;

  return { ...(nomination === undefined ? {} : { nomination }), learningAllowanceRemaining: Math.max(0, context.allowance - spent),
    ...(mode === "normal_improvement" ? { legacyContext } : {}),

    async close() {
      if (closed) return;

      closed = true;

      // Ordinary runs now fund genuine process proposals through the model hook.
      // The standalone legacy commands retain extraction, while execution finish
      // still persists adopted v2 checkpoint feedback without another paid call.
      if (mode !== "legacy_learning") return;

      const records = await scaffold.session!.readRecords();
      if (!records.ok) {
        warn(records.code);
        return;
      }

      const observed = observeWorkflowTurn(records.view.records);
      if (!observed.ok) {
        warn(observed.code);
        return;
      }

      const consumed = await readLearnedWorkflowJobForTurn({ boardRoot, scope, sessionId: observed.value.sessionId,
        turnId: observed.value.turnId, observed: observed.value });
      if (!consumed.ok) {
        warn(consumed.code);
        return;
      }

      if (consumed.value?.latestOutcome?.kind === "learned") {
        ctx.stderr(`workflow_learning ${JSON.stringify({ outcome: consumed.value.latestOutcome, reused: true, modelCalls: 0 })}\n`);
        return;
      }

      if (task === undefined) {
        const classified = await classifyAutomaticWorkflow({ ...context, allowance: Math.max(0, context.allowance - spent) }, {
          text: promptText.slice(0, 12000), scope, families, observed: observed.value, sessionId: scaffold.sessionId,
          watermark: workflowObservationWatermark(records.view.records, observed.value.turnId),
        }, signal);
        if (!classified.ok) {
          warn(classified.code);
          return;
        }

        spent += classified.value.spent;

        if (classified.value.kind !== "classified") {
          warn(classified.value.code);
          return;
        }

        task = classified.value.task;
        parent ??= recommendAutomaticWorkflow(versions, task).learningParent?.versionId;
      }

      const learned = await learnAutomaticWorkflow(context, { task, observed: observed.value,
        adopted: nomination !== undefined, remaining: Math.max(0, context.allowance - spent),
        ...(parent === undefined ? {} : { parentVersionId: parent }) }, signal);
      if (!learned.ok) warn(learned.code);
      else ctx.stderr(`workflow_learning ${JSON.stringify({ ...learned.value, modelUsage: model.usage() })}\n`);
    } };
}
