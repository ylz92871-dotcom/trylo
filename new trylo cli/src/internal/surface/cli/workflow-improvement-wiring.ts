import type { CliContext } from "./context.js";
import type { RunScaffold } from "./run-command.js";
import { buildProvider, reasoningSummaryOptions, type ProviderBuildInput } from "./provider-build.js";
import { createDenyAllPermission } from "./permission.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import { createWorkflowImprovementModel } from "../../learning/agent/subsystems/workflow/adapters/improvement-model.js";
import { projectWorkflowImprovementEvidence, workflowImprovementPublicData } from "../../learning/agent/subsystems/workflow/adapters/improvement-evidence.js";
import { createWorkflowImprovementTools, WORKFLOW_IMPROVEMENT_HOOK } from "../../learning/agent/subsystems/workflow/adapters/improvement-tools.js";
import { createFileWorkflowImprovementRuntime } from "../../learning/agent/subsystems/workflow/adapters/improvement-composition.js";
import { createWorkflowFocusedLearning } from "../../learning/agent/subsystems/workflow/adapters/focused-learning.js";
import type { FileWorkflowImprovementOptions } from "../../learning/agent/subsystems/workflow/adapters/improvement-composition.js";
import { workflowFailure } from "../../learning/agent/subsystems/workflow/domain/trace-parse.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { runCredentialFor } from "./provider-selection.js";
import type { RunCommandOptions } from "./args-primitives.js";
import { legacyWorkflowGuidance, type LegacyWorkflowContext } from "../../learning/agent/subsystems/workflow/runtime/legacy-guidance.js";
import { redactText } from "../../credentials/redact.js";
import { redactJsonValue } from "../../protocol/redact.js";
import { createCentralWorkflowExecution } from "../../integration/central-learning/workflow.js";
import { centralLearningModelRef } from "./central-learning-model.js";

function improvementModel(input: ProviderBuildInput) {
  const provider = buildProvider({ ...input, permission: createDenyAllPermission(), requestAttemptPolicy: "single_request" });
  if ("code" in provider) return workflowFailure(provider.code, "Workflow researcher provider is unavailable");

  const secrets = input.apiKey === undefined ? [] : [input.apiKey];

  return { ok: true as const, value: {
    newModel: (maxPromptChars?: number) => createWorkflowImprovementModel({ provider: provider.fork?.() ?? provider, model: input.model,
      ...(maxPromptChars === undefined ? {} : { maxPromptChars }) }),
    publicData: (value: unknown) => workflowImprovementPublicData(value, secrets), secrets,
  } };
}

/** Per-command selection does not mutate the provider registry or its global default. */
export function standaloneWorkflowImprovementModel(ctx: CliContext, run: RunCommandOptions) {
  const connection = resolveConnectionSettings(ctx, run);
  if ("exitCode" in connection) return workflowFailure("learning_provider_configuration_unavailable", "Review the explicitly selected provider");

  const selected = connection.provider, credential = runCredentialFor(ctx, selected.kind, selected.accountId);
  if ("exitCode" in credential) return workflowFailure("learning_provider_credential_unavailable", "The explicitly selected account has no usable credential");

  return improvementModel({ providerId: selected.providerId, providerKind: selected.kind, model: selected.model,
    endpoint: selected.endpoint, apiKey: credential.apiKey, workspaceRoot: ctx.cwd, ...reasoningSummaryOptions(selected),
    ...(run.reasoningEffort === undefined ? {} : { reasoningEffort: run.reasoningEffort }),
    ...(credential.tokenManager === undefined ? {} : { tokenManager: credential.tokenManager }),
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }) });
}

/** Thin host adaptation: independent transport, canonical journal and the user's existing run allowance. */
export function openWorkflowImprovement(ctx: CliContext, scaffold: RunScaffold, allowance: number, legacy?: LegacyWorkflowContext) {
  if (scaffold.session === undefined) return undefined;

  let open = true;
  const model = improvementModel({ providerId: scaffold.providerId, providerKind: scaffold.providerKind,
    model: scaffold.model, endpoint: scaffold.endpoint, apiKey: scaffold.apiKey, workspaceRoot: scaffold.workspaceRoot,
    ...(scaffold.accountId === undefined ? {} : { accountId: scaffold.accountId }),
    ...(scaffold.reasoningEffort === undefined ? {} : { reasoningEffort: scaffold.reasoningEffort }),
    ...(scaffold.reasoningSummary === undefined ? {} : { reasoningSummary: scaffold.reasoningSummary }),
    ...(scaffold.tokenManager === undefined ? {} : { tokenManager: scaffold.tokenManager }) });
  if (!model.ok) {
    ctx.stderr(`warning: workflow_learning:${model.code}\n`);
    return undefined;
  }

  const original = legacy === undefined ? undefined : legacyWorkflowGuidance(legacy);
  const redactedPrompt = original === undefined ? undefined : redactJsonValue(redactText(original.prompt, model.value.secrets));
  const governance = original === undefined ? undefined : !model.value.publicData(original.evidence)
    ? legacyWorkflowGuidance({ kind: "unavailable", reason: "legacy_workflow_constraint_private", corrections: [] })
    : { ...original, prompt: typeof redactedPrompt === "string" ? redactedPrompt : "Historical context was redacted before dispatch." };
  const runtimeOptions: FileWorkflowImprovementOptions = { boardRoot: workflowBoardRoot(ctx), scope: workspaceIdentity(scaffold.workspaceRoot),
    centralScope: scaffold.workspaceRoot,
    sessionId: scaffold.sessionId, budgetId: scaffold.workflowLearningBudgetId ?? ctx.newId("workflow-learning-budget"),
    allowance: scaffold.centralLearning?.maxTokens ?? allowance, now: ctx.now,
    newModel: model.value.newModel, publicData: model.value.publicData,
    ...(governance === undefined ? {} : { hostEvidence: governance.evidence, dispatchPolicy: governance.dispatchPolicy }),
    warn: code => ctx.stderr(`warning: workflow_learning:${code}\n`),

    async readEvidence() {
      const loaded = await scaffold.session!.readRecords();
      return loaded.ok ? projectWorkflowImprovementEvidence(loaded.view.records, scaffold.sessionId, model.value.secrets)
        : workflowFailure(loaded.code, "Workflow source journal is unavailable");
    } };
  const centralExecution = scaffold.centralLearning === undefined ? undefined : createCentralWorkflowExecution({ ...runtimeOptions,
    modelRef: `workflow-model:${centralLearningModelRef(scaffold)}`,
    enabled: () => open, newModel: maxPromptChars => model.value.newModel(maxPromptChars),
    ...(scaffold.centralLearningContextForIssue === undefined ? {} : { contextForIssue: scaffold.centralLearningContextForIssue }) });
  const runtime = createFileWorkflowImprovementRuntime({ ...runtimeOptions,
    ...(centralExecution === undefined ? {} : { nominateOpportunity: centralExecution.queueOpportunity }) });

  return { tools: createWorkflowImprovementTools(runtime), prompt: [WORKFLOW_IMPROVEMENT_HOOK, governance?.prompt].filter(Boolean).join("\n"),
    focusedLearning: createWorkflowFocusedLearning(runtimeOptions), centralExecution,

    close: async () => {
      open = false;
      await runtime.close();
    } };
}
