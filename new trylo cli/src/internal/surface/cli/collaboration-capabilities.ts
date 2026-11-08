import path from "node:path";
import { createExpertLibraryHost } from "../../adapters/expert-library/index.js";
import { createToolLibrary, createRuntimeToolSource, createBoardToolLearning, createToolLibraryCommandHandler } from "../../tooling/library/host/index.js";
import { emptyUsage, mergeUsage, type ProviderEvent, type ProviderPort, type ProviderRequest } from "../../ports/provider.js";
import type { PermissionPort } from "../../ports/permission.js";
import type { ToolPort, ToolCallRequest, ToolOutcome, ToolSandbox } from "../../ports/tools.js";
import type { SkillCatalogPort } from "../../ports/skills.js";
import type { ExpertExperiencePort } from "../../subagent/experts/index.js";
import { ExpertLibraryError } from "../../subagent/experts/index.js";
import { narrowTeamMemberToolNames, type SubagentTeam } from "../../subagent/team.js";
import type { CentralFundingPort } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { admitToolCall, type ExecPolicyGuard } from "../../loop/tool-admission.js";
import { executeToolOnly } from "../../loop/tool-execution.js";
import { createDoomLoopTracker } from "../../loop/doom-loop.js";
import type { PermissionGrantCache } from "../../loop/permission-grants.js";
import { createProjectToolSelection } from "../../adapters/settings-tool-selection.js";
import { configureBusinessTools } from "./collaboration-tool-configuration.js";
import type { ToolLibraryOptions } from "../../tooling/library/index.js";
import { learningUsageSettlement, type LearningUsageBoundary } from "../../learning/control/usage-settlement.js";

export type CollaborationCapabilitiesOptions = {
  readonly homeRoot: string; readonly boardRoot: string; readonly scope: string; readonly taskId: string;
  readonly tools: ToolPort; readonly workspaceTools: ToolPort; readonly provider: ProviderPort; readonly model: string;
  readonly learningProvider?: ProviderPort;
  readonly catalogTools?: ToolPort; readonly toolSelectionCeiling?: readonly string[];
  readonly signal?: AbortSignal;
  readonly permission: PermissionPort; readonly sandbox: ToolSandbox; readonly grants: PermissionGrantCache;
  readonly execPolicy?: ExecPolicyGuard; readonly team?: SubagentTeam; readonly skills?: SkillCatalogPort;
  readonly experience: ExpertExperiencePort; readonly now: () => string;
};

/** Composition only: library identities, permissions, tools and stores keep their original owners. */
export function createCollaborationCapabilities(options: CollaborationCapabilitiesOptions) {
  const catalog = options.catalogTools ?? options.tools;
  const selection = createProjectToolSelection({ workspaceRoot: options.scope, profileRoot: options.homeRoot });
  const configuredNames = () => options.toolSelectionCeiling === undefined ? selection.read()
    : { ok: true as const, value: options.toolSelectionCeiling };
  const available = (name: string, configured = configuredNames()): boolean => {
    return configured.ok && (configured.value === undefined || configured.value.includes(name))
      && (options.toolSelectionCeiling === undefined || options.toolSelectionCeiling.includes(name))
      && options.permission.isDenied?.(name) !== true;
  };
  const configuredTools: ToolPort = {
    snapshot: () => {
      const configured = configuredNames();
      return catalog.snapshot().filter(tool => available(tool.name, configured));
    },

    execute: (call, signal) => signal.aborted ? Promise.resolve({ outcome: "cancelled" })
      : !available(call.name) ? Promise.resolve({ outcome: "error", code: "tool_not_configured", message: "The original project configuration or explicit invocation ceiling withholds this tool" })
        : catalog.execute(call, signal),
    cancel: id => catalog.cancel(id),
  };
  const doom = createDoomLoopTracker();
  const executeAuthorized = async (call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> => {
    if (signal.aborted) return { outcome: "cancelled" };

    if (activeBuild) {
      const funding = await activeBuild.funding.inspect();
      if (!funding.ok || !funding.active) return { outcome: "cancelled" };
    }

    if (!configuredTools.snapshot().some(t => t.name === call.name)) return { outcome: "error", code: "tool_unavailable", message: call.name };

    const admission = await admitToolCall({ permission: options.permission, sandbox: options.sandbox, grants: options.grants, doom,
      ...(options.execPolicy === undefined ? {} : { execPolicy: options.execPolicy }) }, call);
    if (signal.aborted || admission.kind === "cancelled") return { outcome: "cancelled" };

    if (admission.kind !== "approved") return { outcome: "error", code: `tool_${admission.kind}`, message: "The original execution admission did not approve this resource call" };

    if (activeBuild) {
      const funding = await activeBuild.funding.inspect();
      if (!funding.ok || !funding.active) return { outcome: "cancelled" };
    }

    return executeToolOnly(configuredTools, call, signal);
  };
  const toolLibraryOptions: ToolLibraryOptions = {
    sources: [createRuntimeToolSource({ tools: catalog, builtinNames: new Set(options.workspaceTools.snapshot().map(t => t.name)),
      production: { boardRoot: options.boardRoot, workspaceId: options.scope } })],

    access: async context => {
      if (context.scope !== options.scope) return { ok: false, code: "scope_mismatch", message: "Library workspace differs from the active task" };

      if (context.memberId === "personal_agent") {
        const configured = configuredNames();
        if (!configured.ok) return configured;
        return { ok: true, value: { tools: catalog, configuredNames: configured.value,
          ...(options.toolSelectionCeiling === undefined ? {} : { allowedNames: options.toolSelectionCeiling }), permission: options.permission } };
      }

      const member = options.team?.members.find(m => m.memberId === context.memberId);
      if (!member) return { ok: false, code: "member_unavailable", message: "Member is absent from the real frozen team" };

      return { ok: true, value: { tools: catalog, configuredNames: member.role.allowedTools,
        allowedNames: narrowTeamMemberToolNames(member, configuredTools.snapshot().map(t => t.name), options.team?.surface), permission: options.permission } };
    },

    configure: (context, names) => configureBusinessTools({ permission: options.permission, selection,
      ...(options.signal === undefined ? {} : { signal: options.signal }) }, context, names),
    learning: createBoardToolLearning({ boardRoot: options.boardRoot, permission: () => options.permission, now: () => Date.parse(options.now()) }),
  };
  const toolLibrary = createToolLibrary(toolLibraryOptions);
  let activeBuild: { requestId: string; funding: CentralFundingPort } | undefined;
  const provider: ProviderPort = { async *stream(request, signal) {
    const associated = expertHost.library.requests().find(r => request.attemptId === `expert-${r.requestId}-r${r.revision}`)?.association;
    if (associated && (!activeBuild || associated.grantId === undefined)) throw new Error("Central expert construction requires its original active claim");

    const parent = associated ? options.learningProvider ?? options.provider : options.provider;
    const isolated = parent.fork?.([]);
    if (!isolated || isolated === parent) throw new Error("Expert provider isolation unavailable");

    if (!associated) {
      yield* isolated.stream(request, signal);
      return;
    }

    const build = activeBuild!;
    const current = await build.funding.inspect();
    if (!current.ok || !current.active || current.grant.grantId !== associated.grantId
      || request.attemptId !== `expert-${build.requestId}-r${expertHost.library.request(build.requestId).revision}`) throw new Error("Central expert construction claim is stale");

    const inputTokens = Math.ceil(new TextEncoder().encode(JSON.stringify(request.messages)).length / 2) + 256;

    if (JSON.stringify(request.messages).length > current.grant.allowance.maxPromptChars) throw new Error("Central expert construction prompt allowance exceeded");

    const maxOutputTokens = Math.min(request.maxOutputTokens ?? 4096, current.remaining.tokens - inputTokens);
    if (maxOutputTokens < 256) throw new Error("Central expert construction budget exhausted");

    const reservationId = `expert-build:${build.requestId}:${current.grant.claim!.claimId}`;
    const maxTokens = inputTokens + maxOutputTokens;
    const reservation = await build.funding.reserve({ reservationId, maxTokens });
    if (!reservation.ok || reservation.status === "duplicate") throw new Error("Central expert construction reservation unavailable");

    yield* accountExpertStream(isolated, { ...request, maxOutputTokens }, signal,
      { funding: build.funding, reservationId, maxTokens, model: options.model });
  } };
  const expertHost = createExpertLibraryHost({ rootDir: path.join(options.homeRoot, "experts"), permission: options.permission,
    provider, model: options.model, maxOutputTokens: 4096, maxPromptChars: 40000,
    executeAuthorized, availableToolNames: () => configuredTools.snapshot().map(t => t.name), toolLibrary,
    ...(options.skills === undefined ? {} : { skills: options.skills }), experience: options.experience });

  return {
    toolLibrary, expertHost, executeAuthorized, configuredTools,

    executeTool: (memberId: string, command: unknown, signal: AbortSignal) => {
      const scopedSignal = options.signal === undefined ? signal : AbortSignal.any([signal, options.signal]);
      const library = createToolLibrary({ ...toolLibraryOptions, configure: (context, names) => configureBusinessTools({
        permission: options.permission, selection, signal: scopedSignal }, context, names) });
      return createToolLibraryCommandHandler(library)({ memberId, scope: options.scope }, command, scopedSignal);
    },

    async buildExpert(requestId: string, funding: CentralFundingPort, signal: AbortSignal) {
      if (activeBuild) throw new Error("An expert construction is already using this host");
      activeBuild = { requestId, funding };
      try { return await expertHost.library.build(requestId, { signal, useScope: { workspaceId: options.scope, taskId: options.taskId } }); }
      finally { activeBuild = undefined; }
    },
  };
}

export type CollaborationCapabilities = ReturnType<typeof createCollaborationCapabilities>;

/** The actual expert consumer drains through EOF; a partial frame is not a final bill. */
async function* accountExpertStream(provider: ProviderPort, request: ProviderRequest, signal: AbortSignal, call: {
  readonly funding: CentralFundingPort; readonly reservationId: string; readonly maxTokens: number; readonly model: string;
}): AsyncIterable<ProviderEvent> {
  let usage = emptyUsage(), reported = false;
  let boundary: LearningUsageBoundary = { kind: "pending" };
  let finish: Extract<ProviderEvent, { type: "finish" }> | undefined;

  try {
    for await (const event of provider.stream(request, signal)) {
      if (event.type === "usage") {
        usage = mergeUsage(usage, event.usage);
        reported = true;
        if (usage.totalTokens > call.maxTokens) {
          boundary = { kind: "overrun" };
          throw new ExpertLibraryError("resource_unavailable", "Central expert construction exceeded its token reservation");
        }
      }

      if (signal.aborted || event.type === "cancel_ack") throw new ExpertLibraryError("cancelled", "Central expert construction was cancelled");

      if (event.type === "error") {
        boundary = { kind: "unknown", reason: "provider_stream_failed" };
        yield event;
        return;
      }

      if (event.type === "warning" && event.code === "stream_finish_tail_timeout") boundary = { kind: "unknown", reason: "provider_usage_tail_incomplete" };

      if (event.type === "finish") finish = event;

      yield event;
    }
    if (boundary.kind === "pending" && finish?.reason === "stop" && !finish.requiresFollowUp) boundary = { kind: "complete" };
  } catch (error) {
    if (boundary.kind !== "overrun") boundary = { kind: "unknown", reason: signal.aborted ? "cancelled" : "provider_stream_failed" };
    throw error;
  } finally {
    if (signal.aborted && boundary.kind !== "overrun") boundary = { kind: "unknown", reason: "cancelled" };
    const receipt = learningUsageSettlement(boundary, reported ? { totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: call.model } : undefined);
    const settled = await call.funding.settle({ reservationId: call.reservationId, usage: receipt });
    if (!settled.ok) throw new Error(`Expert construction accounting failed: ${settled.reason}`);
  }
}
