import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createProjectToolSelection } from "../../adapters/settings-tool-selection.js";
import { createToolLibrary, createRuntimeToolSource } from "../../tooling/library/host/index.js";
import type { ToolLearningPlan } from "../../learning/agent/subsystems/tool/domain/evolution/index.js";
import type { ToolPlanningSupplement } from "../../learning/agent/subsystems/tool/runtime/index.js";
import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import { permissionFor } from "./permission-for-run.js";
import { tryloHome } from "./session-paths.js";
import { productionToolsForTurn } from "./tool-production-wiring.js";
import { composeAdditionalTools } from "./additional-tools.js";
import { retrieveToolReuseCandidates, type ToolLibraryInvestigation, type ToolReuseCandidate } from "../../learning/agent/subsystems/tool/domain/evolution/reuse-retrieval.js";

type ContextInput = { readonly boardRoot: string; readonly scope: string; readonly run: RunCommandOptions };

/** Read the existing base runtime/library owners; this worker never executes this catalog. */
export async function toolLearningContextFor(ctx: CliContext, input: ContextInput, plan: ToolLearningPlan, signal: AbortSignal): Promise<ToolPlanningSupplement> {
  const inventory = await readToolLearningInventory(ctx, input, plan, signal);
  return { availableTools: retrieveToolReuseCandidates({ candidates: inventory.candidates,
    query: `${plan.capability} ${plan.opportunity?.assessment.need ?? ""} ${plan.trigger.tool ?? ""}`,
    ...(plan.trigger.tool === undefined ? {} : { target: plan.trigger.tool }),
    ...(plan.targetVersionId === undefined ? {} : { targetVersionId: plan.targetVersionId }) }), requirements: inventory.requirements };
}

/** A model may reformulate local retrieval without configuring or invoking any tool. */
export async function toolLearningLookupFor(ctx: CliContext, input: ContextInput, plan: ToolLearningPlan, query: string, signal: AbortSignal): Promise<ToolLibraryInvestigation> {
  const inventory = await readToolLearningInventory(ctx, input, plan, signal, query);
  const candidates = retrieveToolReuseCandidates({ candidates: inventory.candidates, query,
    ...(plan.trigger.tool === undefined ? {} : { target: plan.trigger.tool }),
    ...(plan.targetVersionId === undefined ? {} : { targetVersionId: plan.targetVersionId }) });
  return { query, candidates, total: inventory.total, truncated: inventory.total > candidates.length };
}

async function readToolLearningInventory(ctx: CliContext, input: ContextInput, plan: ToolLearningPlan, signal: AbortSignal, query?: string): Promise<{
  readonly candidates: readonly ToolReuseCandidate[]; readonly total: number; readonly requirements: ToolPlanningSupplement["requirements"];
}> {
  if (signal.aborted) return { candidates: [], total: 0, requirements: [] };

  const sandbox = createWorkspaceSandbox({ workspaceRoot: ctx.cwd });
  const workspace = createWorkspaceTools({ workspaceRoot: ctx.cwd, sandbox });
  const production = await productionToolsForTurn(ctx, { learning: "tool", workspaceId: input.scope, sessionId: plan.trigger.runId });
  const tools = production === undefined ? workspace : composeAdditionalTools(workspace, production.tools);

  try {
    const permission = permissionFor("non_interactive", ctx, input.run);
    const selection = createProjectToolSelection({ workspaceRoot: ctx.cwd, profileRoot: tryloHome(ctx.homeDir, ctx.env) }).read();
    if (!selection.ok) throw new Error("tool_learning_configuration_unavailable");

    const library = createToolLibrary({ sources: [createRuntimeToolSource({ tools, builtinNames: new Set(workspace.snapshot().map(tool => tool.name)),
      production: { boardRoot: input.boardRoot, workspaceId: input.scope } })],
      access: async () => ({ ok: true, value: { tools, configuredNames: selection.value,
        ...(input.run.toolSelection === undefined ? {} : { allowedNames: input.run.toolSelection }), permission } }) });
    const context = { memberId: "tool_learning", scope: input.scope };
    let queried = await library.query(context, { ...(query === undefined ? {} : { text: query }), limit: 256 });
    if (!queried.ok) throw new Error("tool_learning_catalog_unavailable");

    if (query !== undefined && queried.value.items.length === 0) {
      queried = await library.query(context, { limit: 256 });
      if (!queried.ok) throw new Error("tool_learning_catalog_unavailable");
    }

    const targetName = plan.opportunity?.assessment.tool ?? plan.trigger.tool;
    const targeted = targetName === undefined || queried.value.items.some(entry => entry.id === targetName || entry.name === targetName)
      ? undefined : await library.query(context, { text: targetName, limit: 256 });
    if (targeted !== undefined && !targeted.ok) throw new Error("tool_learning_catalog_unavailable");

    const entries = [...new Map([...queried.value.items, ...(targeted?.ok === true ? targeted.value.items : [])]
      .filter(entry => entry.availability.state === "available" && entry.configuration !== "blocked").map(entry => [entry.id, entry])).values()];
    const explicit = plan.trigger.action === "user_requested" || plan.opportunity?.source === "user";
    const bindings = tools.snapshot();
    const target = bindings.find(tool => tool.name === (plan.opportunity?.assessment.tool ?? plan.trigger.tool));

    return {
      candidates: entries.map(entry => {
        const versionId = bindings.find(tool => tool.name === entry.runtimeName)?.versionId;
        return { toolId: entry.id, name: entry.name, capabilities: entry.capabilities, description: entry.description,
          ...(versionId === undefined ? {} : { versionId }) };
      }),
      total: Math.max(queried.value.total, entries.length),
      requirements: [...(explicit ? [{ ref: `task:${plan.trigger.runId}`, kind: "user_requirement" as const,
        text: plan.opportunity?.assessment.need ?? plan.capability }] : []),
        ...(target === undefined ? [] : [{ ref: `tool-contract:${target.name}`, kind: "tool_contract" as const,
          text: `${target.description}\nInput schema: ${JSON.stringify(target.parameters)}`.slice(0, 4000) }])],
    };
  } finally { await production?.close(); }
}
