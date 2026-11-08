import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args-primitives.js";
import { parseRun } from "./args-run.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { runCredentialFor } from "./provider-selection.js";
import { buildProvider, reasoningSummaryOptions } from "./provider-build.js";
import { createDenyAllPermission } from "./permission.js";
import { createWorkflowModelPort } from "../../adapters/provider/workflow-worker.js";
import type { AutomaticWorkflowContext } from "../../integration/workflow-learning/automatic-runtime.js";
import type { WorkflowLearningResult } from "../../learning/domains/workflow/trace-contracts.js";
import { workflowFailure } from "../../learning/domains/workflow/trace-parse.js";
import { workflowBoardRoot } from "./workflow-paths.js";

/** Only connection overrides are accepted; no task, tool or execution flags are composed. */
export function parseWorkflowProviderFlags(argv: readonly string[]): WorkflowLearningResult<RunCommandOptions> {
  for (let index = 0; index < argv.length;) {
    const token = argv[index] ?? "", equal = token.indexOf("=");
    const name = equal < 0 ? token : token.slice(0, equal);
    if (!["--provider", "--model", "--endpoint", "--reasoning-effort"].includes(name)) {
      return workflowFailure("workflow_usage", "workflow work accepts only provider/model/endpoint/reasoning-effort overrides after --");
    }
    index += equal < 0 ? 2 : 1;
  }

  const parsed = parseRun(argv);

  return parsed.kind === "run" ? { ok: true, value: parsed.options } : workflowFailure("workflow_usage", "invalid workflow learning provider options");
}

export function standaloneWorkflowContext(ctx: CliContext, run: RunCommandOptions, allowance: number): WorkflowLearningResult<AutomaticWorkflowContext> {
  const connection = resolveConnectionSettings(ctx, run);
  if ("exitCode" in connection) return workflowFailure("learning_provider_configuration_unavailable", "review the selected provider configuration");

  const selected = connection.provider;
  const credential = runCredentialFor(ctx, selected.kind, selected.accountId);
  if ("exitCode" in credential) return workflowFailure("learning_provider_credential_unavailable", "the selected account has no usable credential");

  const provider = buildProvider({ providerId: selected.providerId, providerKind: selected.kind, model: selected.model,
    endpoint: selected.endpoint, apiKey: credential.apiKey, workspaceRoot: ctx.cwd, permission: createDenyAllPermission(),
    ...reasoningSummaryOptions(selected), ...(run.reasoningEffort === undefined ? {} : { reasoningEffort: run.reasoningEffort }),
    ...(credential.tokenManager === undefined ? {} : { tokenManager: credential.tokenManager }),
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }) });

  return "code" in provider ? workflowFailure("learning_provider_configuration_unavailable", provider.code)
    : { ok: true, value: { boardRoot: workflowBoardRoot(ctx), now: () => new Date(ctx.now()).toISOString(),
      model: createWorkflowModelPort({ provider, model: selected.model, allowance }), allowance } };
}

/** Borrow the process root's interrupt surface; never leave a learning observer installed. */
export async function withWorkflowLearningSignal<T>(ctx: CliContext, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(), cancel = () => controller.abort();
  const interrupts = ctx.interrupts?.unobserve === undefined ? undefined : ctx.interrupts;
  interrupts?.observe(cancel);
  try { return await work(controller.signal); }
  finally { interrupts?.unobserve?.(cancel); }
}
