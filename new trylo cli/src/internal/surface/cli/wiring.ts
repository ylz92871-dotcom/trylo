import type { WiringInput } from "./wiring-input.js";

export type { WiringInput, McpToolTable } from "./wiring-input.js";

import { composeSandbox, composeTools } from "../../adapters/mcp-runtime/mount.js";
import { createFixtureProvider, DEFAULT_FIXTURE_SCRIPT } from "../../adapters/provider/fixture.js";
import { buildProvider, kindOf } from "./provider-build.js";
import { buildLearningProvider } from "./funded-learning-provider.js";
import { SubagentRuntime } from "../../subagent/index.js";
import { buildSubagentPorts } from "./wiring-subagent.js";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { MEMORY_WRITE_TOOL_NAMES } from "../../adapters/tools/memory/write.js";
import { mountedWebToolNames } from "./web-wiring.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { lspToolsPatch } from "./lsp-wiring.js";
import { createRunExecution } from "./run-execution-wiring.js";
import { composeLearningPorts, methodSwitchFor } from "../../integration/user-learning/index.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import type { LoopPorts } from "../../loop/runner.js";
import type { ToolPort } from "../../ports/tools.js";
import { createSkillForkExecutor } from "../../adapters/tools/skill/index.js";
import type { ProviderPort } from "../../ports/provider.js";
import { checkpointWiring } from "./checkpoint-wiring.js";
import { createModelSummarizer, DEFAULT_COMPACT_SUMMARY_MODE } from "./compact-model-summarizer.js";
import { createPageExtractor } from "./web-wiring.js";
import { boundMessagesTextTokens, compactionWiring } from "./compaction-wiring.js";
import {
  openPermissionLedger,
  type FilePermissionStore,
} from "./permission-ledger-wiring.js";
import { selectToolPort } from "./tool-selection.js";
import { methodPortOf, methodFocusedPortOf, learningToolsOf } from "./wiring-method.js";
import { imageReferencesFor } from "./wiring-image-references.js";
import { restrictDeniedTools } from "./permission-tool-access.js";
import { composeAdditionalTools } from "./additional-tools.js";
import { createPersonalAgentRuntime, type PersonalAgentRuntime } from "./collaboration-personal-agent-wiring.js";
import type { CentralLearningTurnRuntime } from "./central-learning-turn.js";

/**
 * The opt-in types moved to `wiring-optins.ts`; re-exported here because the
 * session fingerprint, the permission plan and the learning wiring have always
 * imported them from this module, and a move that forced every one of them to
 * change its import would be a refactor nobody asked for.
 */
export type {
  MethodLearningInput,
  SubagentWiringInput,
  WiringOptIns,
} from "./wiring-optins.js";

/**
 * Port wiring for the CLI composition root.
 *
 * Everything a run needs is chosen here and nowhere else. Three facts about
 * this file are load-bearing:
 *
 *  - the profile port is pinned to the packaged `no_learning` snapshot, because
 *    P01's external evidence authority and activation path are not accepted yet
 *    and the real CLI must not consume them;
 *  - the sandbox exists before the tools do. Mutating tools are only advertised
 *    when there is something able to bound them, so the model is never shown a
 *    capability that every layer has already decided to refuse;
 *  - the grant cache is one object shared by the tool catalog and the loop, so
 *    "this tool was turned off" and "this tool is not offered" can never
 *    disagree.
 *
 * A fourth fact is about the method subsystem (`§9`): it is **off unless asked
 * for**. Absent `WiringInput.learning` nothing is constructed at all — no store,
 * no `load()`, no lock, no directory — so `LoopPorts.method` is `undefined` and
 * a run is byte-identical to one that never heard of learning. The switch's own
 * value is interpreted in exactly one place (`integration/method/wiring.ts`),
 * and the home formula is borrowed from `session-paths.ts::tryloHome` rather
 * than re-derived here.
 */

export type WiringFailure = {
  readonly code: "missing_endpoint" | "unknown_provider" | "unsupported_reasoning_effort" | "tool_name_conflict";
  readonly detail: string;
};

export type Wiring = {
  readonly centralLearning?: CentralLearningTurnRuntime;
  readonly collaboration?: PersonalAgentRuntime;
  readonly capabilities?: import("./collaboration-capabilities.js").CollaborationCapabilities;
  /** Releases only resources this turn constructed; lent sessions remain with their owner. */
  readonly close: () => Promise<void>;
  readonly ports: LoopPorts;
  readonly toolCatalogHash: string;
  readonly providerId: string;
  readonly model: string;
  readonly subagentRuntime?: SubagentRuntime;
  /**
   * 本次运行所背书的持久账本；开关关闭时**不存在这个字段**（而不是一个空对象），
   * 所以「有没有账本」是一个可以 `in` 判断的事实，不需要相信某个哨兵值。
   */
  readonly permissionLedger?: FilePermissionStore;
};

/**
 * The catalog identity vocabulary (hashes, the pinned profile, the write-tool
 * set) lives in `wiring-catalog.ts` under `wiring.ts`'s file-size gate; it is
 * re-exported here because the session fingerprint and the permission plan
 * have always read it from this module.
 */
import {
  catalogHash,
  NO_LEARNING_PROFILE,
  toolCatalogHash,
  workspaceIdentity,
  workspaceWriteToolNames,
} from "./wiring-catalog.js";

export { catalogHash, NO_LEARNING_PROFILE, toolCatalogHash, workspaceIdentity, workspaceWriteToolNames };

function isFailure(value: ProviderPort | WiringFailure): value is WiringFailure {
  return typeof (value as WiringFailure).code === "string";
}

export function wirePorts(input: WiringInput): Wiring | WiringFailure {
  const workspaceRoot = input.execution?.workspaceRoot ?? input.workspaceRoot;
  const sandbox = createWorkspaceSandbox({
    workspaceRoot,
    ...(input.fileAccess === undefined ? {} : { fileAccess: input.fileAccess }),
    // Same mode the tools will plan with: approval and execution plan twice
    // so they agree, never so they can disagree.
    ...(input.shellMode === undefined ? {} : { shellMode: input.shellMode }),
  });
  const images = imageReferencesFor(input);
  const provider = buildProvider({ ...input, workspaceRoot: sandbox.policy.workspaceRoot }, images?.read);
  if (isFailure(provider)) return provider;

  const needsLearningProvider = methodSwitchFor(input.learning?.switch) !== undefined
    || input.centralLearning !== undefined || input.collaborationLearning !== undefined && input.collaborationLearning.choice !== "off";
  const learningProvider = needsLearningProvider
    ? buildLearningProvider({ ...input, workspaceRoot: sandbox.policy.workspaceRoot }, provider, images?.read) : provider;
  if (isFailure(learningProvider)) return learningProvider;

  const grants = input.grants ?? createPermissionGrantCache();
  const methodBase = methodPortOf({ ...input, provider: learningProvider,
    ...(input.centralLearning === undefined || input.learning === undefined ? {} : { learning: { ...input.learning, deferReviewToCentral: true } }) });
  const topicMethod = input.topics?.attach(methodBase) ?? methodBase;
  const method = composeLearningPorts({ method: topicMethod, user: input.userLearning });
  // Both registries are built in session-view-wiring and nowhere else, so the
  // tools that observe a command and the processes they observe are the same
  // objects (see that module for why a second registry breaks sessions).
  const execution = input.execution ?? createRunExecution(input.workspaceRoot);
  const sessions = execution.sessions;
  const lsp = lspToolsPatch(input);
  // WP14（14.3）：fork 技能委托给子代理端口。子代理运行时在下方才构造，所以
  // 这里晚绑定：skill 真正执行时（远晚于 wiring 完成）才解析委托端口。开关
  // 关闭时 skillFork 不存在，fork 技能以 `skill_fork_unavailable` 终局。
  const isSubagentEnabled = kindOf(input) === "fixture-subagent" || input.subagent?.enabled === true;
  let subagentToolPort: ToolPort | undefined;
  const skillFork =
    input.skills === undefined || !isSubagentEnabled
      ? undefined
      : createSkillForkExecutor({ delegate: () => subagentToolPort });
  const effectiveToolSelection = input.toolSelection ?? input.configuredToolSelection;
  const explicitToolCeiling = input.toolSelectionCeiling ?? input.toolSelection;
  const mountedWorkspaceTools = createWorkspaceTools({
    ...(input.readRouting === undefined ? {} : { readRouting: input.readRouting }),
    ...(input.workflowRecords === undefined ? {} : { workflowRecords: input.workflowRecords }),
    ...(input.goal === undefined ? {} : { goalTools: input.goal.tools }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.questions === undefined ? {} : { questions: input.questions }),
    workspaceRoot,
    sandbox,
    ...(images === undefined ? {} : { onImageValidated: images.record }),
    visibility: grants,
    allowWeb: input.allowWeb === true,
    // The extractor is attached here, not by the caller, because this is the
    // first line that holds a live provider. `run-command.ts` knows which
    // provider was *selected*; only here does one *exist*. Same reason, same
    // shape as the compaction summarizer below (line 296): a capability that
    // needs a provider is built from the provider this layer built. Absent web
    // config means no network tool at all, so there is nothing to attach to.
    ...(input.web === undefined
      ? {}
      : { web: { ...input.web, extractor: createPageExtractor({ provider, model: input.model }) } }),
    sessions,
    spawner: execution.spawner,
    ...(input.memory === undefined ? {} : { memory: input.memory }),
    ...(input.memoryWrite === undefined ? {} : { memoryWrite: input.memoryWrite }),
    ...(input.skills === undefined
      ? {}
      : { skills: input.skills, ...(skillFork === undefined ? {} : { skillFork }) }),
    ...(input.localRules === undefined ? {} : { localRules: input.localRules }),
    ...lsp,
    ...(input.shellMode === undefined ? {} : { shellMode: input.shellMode }),
  });
  const workspaceTools = restrictDeniedTools(selectToolPort(mountedWorkspaceTools, effectiveToolSelection), input.permission);
  // The composites. Both are identity-shaped when nothing was mounted, so
  // "MCP off" is the old objects rather than equal-looking new ones — the
  // difference a hash or a `===` would otherwise have to be trusted about.
  // The web tools join MCP's admission pattern, not the planner's: the workspace
  // planner refuses any name it has no plan for, so what admits a fetch is the
  // fact that it was *mounted*, never a global planner branch that would also
  // change how a flag-off run answers a hallucinated `web_fetch` call.
  const mcp = input.mcp;
  const withMcp = mcp === undefined ? workspaceTools : composeTools(workspaceTools, mcp.tools);
  const methodTools = learningToolsOf(methodBase, input.toolGap, input.turnId);
  if (methodTools !== undefined && input.additionalTools?.snapshot().some(tool => methodTools.snapshot().some(item => item.name === tool.name))) return { code: "tool_name_conflict", detail: "method tool collides with an additional tool" };

  const additional = methodTools === undefined ? input.additionalTools : input.additionalTools === undefined ? methodTools : composeAdditionalTools(input.additionalTools, methodTools);
  const extra = additional === undefined ? undefined : restrictDeniedTools(selectToolPort(additional, effectiveToolSelection), input.permission);
  if (extra?.snapshot().some(binding => withMcp.snapshot().some(existing => existing.name === binding.name))) return { code: "tool_name_conflict", detail: "additional tool collides with an existing tool" };

  const tools = restrictDeniedTools(selectToolPort(extra === undefined ? withMcp : composeAdditionalTools(withMcp, extra), effectiveToolSelection), input.permission);
  const fullWithMcp = mcp === undefined ? mountedWorkspaceTools : composeTools(mountedWorkspaceTools, mcp.tools);
  const catalogTools = additional === undefined ? fullWithMcp : composeAdditionalTools(fullWithMcp, additional);
  const dispatchTools = restrictDeniedTools(selectToolPort(catalogTools, explicitToolCeiling), input.permission);

  if (input.turnId !== undefined) input.toolGap?.captureCatalog?.(input.turnId, dispatchTools.snapshot());

  const webNames = mountedWebToolNames(workspaceTools);
  const memoryNames = workspaceTools.snapshot().filter((tool) => MEMORY_WRITE_TOOL_NAMES.has(tool.name)).map((tool) => tool.name);
  const admitted =
    webNames.length > 0 || memoryNames.length > 0 || mcp !== undefined || extra !== undefined
      ? new Set([...(mcp === undefined ? [] : mcp.toolNames), ...webNames, ...memoryNames, ...(extra?.snapshot().map(tool => tool.name) ?? [])])
      : undefined;
  const baseSandbox = admitted === undefined ? sandbox : composeSandbox(sandbox,
    () => new Set([...admitted, ...(mcp?.toolNames ?? [])]));
  const methodFocused = methodBase === undefined ? undefined : methodFocusedPortOf({ ...input, provider: learningProvider, method: methodBase });
  let centralLearning: CentralLearningTurnRuntime | undefined;
  const collaboration = input.collaborationLearning === undefined ? undefined : createPersonalAgentRuntime({
    ...input.collaborationLearning, provider, learningProvider, model: input.model, tools, workspaceTools: mountedWorkspaceTools, catalogTools,
    ...(methodFocused === undefined ? {} : { focusedLearning: { ...input.collaborationLearning.focusedLearning, method: methodFocused } }),
    ...(input.centralLearning === undefined ? {} : { centralLearning: {
      focus: (request, signal) => centralLearning?.focus(request, signal) ?? Promise.resolve({ ok: false as const, reason: "central_learning_not_ready" }),
      resume: signal => centralLearning?.resume(signal) ?? Promise.resolve({ ok: false as const, reason: "central_learning_not_ready" }),
    }, beforeCentralInspect: async () => { await centralLearning?.beforeInspect(); },
    readCentralLearningInstruction: () => centralLearning?.personalAgentInstruction }),
    ...(input.goal === undefined ? {} : { taskGoal: input.goal.current().objective }),
    ...(explicitToolCeiling === undefined ? {} : { toolSelectionCeiling: explicitToolCeiling }), permission: input.permission,
    sandbox: baseSandbox, grants, ...(input.skills === undefined ? {} : { skills: input.skills }),
    ...(input.execPolicy === undefined ? {} : { execPolicy: input.execPolicy }) });
  if (input.centralLearning !== undefined && collaboration !== undefined) centralLearning = input.centralLearning({
    provider: learningProvider, collaboration, ...(methodBase === undefined ? {} : { method: methodBase }),
    ...(input.learning === undefined ? {} : { learning: input.learning }) });

  const centralNames = centralLearning?.tools.snapshot().map(tool => tool.name) ?? [];
  const effectiveSandbox = collaboration === undefined ? baseSandbox
    : composeSandbox(baseSandbox, new Set([...collaboration.tools.snapshot().map(tool => tool.name), ...centralNames]));

  let subagentRuntime: SubagentRuntime | undefined;
  const presentationProvider = mcp?.wrapProvider?.(provider) ?? provider;
  const personalAgentProvider = collaboration?.wrapProvider(presentationProvider) ?? presentationProvider;
  let parentProvider = personalAgentProvider;
  let finalTools = collaboration === undefined ? tools : composeAdditionalTools(collaboration.capabilities.configuredTools,
    centralLearning?.wrapControlTools(collaboration.tools) ?? collaboration.tools);

  if (centralLearning !== undefined) finalTools = composeAdditionalTools(finalTools, centralLearning.tools);

  // This port joins only the parent's table. The child runtime below receives
  // workspaceTools/dispatchTools, which do not contain the review boundary.
  if (input.skillPending !== undefined) {
    const pending = restrictDeniedTools(selectToolPort(input.skillPending.tools, explicitToolCeiling), input.permission);
    if (pending.snapshot().some(tool => finalTools.snapshot().some(existing => existing.name === tool.name))) {
      return { code: "tool_name_conflict", detail: "skill pending tool collides with an existing tool" };
    }
    finalTools = composeAdditionalTools(finalTools, pending);
  }

  // 开关关闭时这里什么都不发生：不构造对象、不开文件、不建目录。构造本身是纯的
  // （`createFilePermissionStore` 只把路径与锁闭包记下来），真正的读取发生在
  // `host.ts` 的就绪校验里。
  const permissionLedger =
    input.permissionLedger === undefined ? undefined : openPermissionLedger(input.permissionLedger);

  if (isSubagentEnabled) {
    const built = buildSubagentPorts({
      ...(input.subagent?.onChildRequestDispatched === undefined ? {} : { onChildRequestDispatched: input.subagent.onChildRequestDispatched }),
      ...((input.subagent?.onMemberCollaborationReport ?? collaboration?.onMemberCollaborationReport) === undefined ? {} : {
        onMemberCollaborationReport: input.subagent?.onMemberCollaborationReport ?? collaboration!.onMemberCollaborationReport }),
      ...((input.subagent?.memberConfigurations ?? collaboration?.memberConfigurations) === undefined ? {} : {
        memberConfigurations: input.subagent?.memberConfigurations ?? collaboration!.memberConfigurations }),
      ...((input.subagent?.teamProfileId ?? input.subagent?.team?.profileId) === undefined ? {} : {
        teamProfileId: input.subagent?.teamProfileId ?? input.subagent!.team!.profileId! }),
      ...(input.subagent?.routing === undefined ? {} : { routing: input.subagent.routing }),
      ...((input.subagent?.collaboration ?? collaboration?.member) === undefined ? {} : { collaboration: input.subagent?.collaboration ?? collaboration!.member }),
      ...(input.subagent?.onCollaborationFailure === undefined ? {} : { onCollaborationFailure: input.subagent.onCollaborationFailure }),
      ...(input.subagent?.checkpoints === undefined ? {} : { checkpoints: input.subagent.checkpoints }),
      ...(input.subagent?.modelMigration === undefined ? {} : { modelMigration: input.subagent.modelMigration }),
      ...(input.subagent?.sessionId === undefined ? {} : { sessionId: input.subagent.sessionId }),
      sessions,
      parentTools: finalTools,
      parentProvider: personalAgentProvider,
      workspaceTools: collaboration === undefined ? workspaceTools : dispatchTools,
      childProvider:
        kindOf(input) === "fixture-subagent"
          ? createFixtureProvider(DEFAULT_FIXTURE_SCRIPT)
          : mcp?.wrapProvider?.(provider) ?? provider,
      model: input.model,
      permission: input.permission,
      ...(input.contextTokenLimit === undefined ? {} : { childBudget: { contextTokenLimit: input.contextTokenLimit } }),
      grants,
      ...(input.execPolicy === undefined ? {} : { execPolicy: input.execPolicy }),
      callerMessages: input.callerMessages,
      sandbox: effectiveSandbox,
      ...(input.subagent?.onEvent === undefined ? {} : { onEvent: input.subagent.onEvent }),
      ...(input.subagent?.governance === undefined
        ? {}
        : { governance: input.subagent.governance }),
      ...(input.subagent?.idGenerator === undefined
        ? {}
        : { idGenerator: input.subagent.idGenerator }),
      ...(input.subagent?.roles === undefined ? {} : { roles: input.subagent.roles }),
      ...(input.subagent?.team === undefined ? {} : { team: input.subagent.team }),
    });

    subagentRuntime = built.runtime;
    parentProvider = built.provider;
    // WP14：晚绑定的 fork 委托出口在这里闭合——skill 工具执行时，子代理端口
    // 已经存在。挂在同一个端口上，血统/治理/取消只有一份实现（WP22）。
    subagentToolPort = built.toolPort;
    finalTools = collaboration?.wrapParentTools(built.tools) ?? built.tools;
  }

  finalTools = selectToolPort(finalTools, explicitToolCeiling);
  const parentSandbox = input.skillPending === undefined ? effectiveSandbox : composeSandbox(effectiveSandbox,
    new Set(input.skillPending.tools.snapshot().filter(tool => finalTools.snapshot().some(item => item.name === tool.name)).map(tool => tool.name)));

  return {
    ...(centralLearning === undefined ? {} : { centralLearning }),
    ...(collaboration === undefined ? {} : { collaboration, capabilities: collaboration.capabilities }),
    ports: {
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      provider: parentProvider,
      tools: finalTools,
      permission: input.permission,
      profile: NO_LEARNING_PROFILE,
      ...(input.execPolicy === undefined ? {} : { execPolicy: input.execPolicy }),
      sandbox: parentSandbox,
      grants,
      // Opted in only when the host lends a clock. The loop estimates the next
      // request itself; this estimator exists so a caller that supplies one
      // uses the same pure basis rather than a second, drifting one.
      compaction: compactionWiring({
        estimateAccuracy: "text_upper_bound",
        estimatePromptTokens: messages => boundMessagesTextTokens(messages) + (provider.continuation?.estimateOverheadTokens?.(messages) ?? 0),
        estimateTextPromptTokens: boundMessagesTextTokens,
        nowMs: input.nowMs ?? 0,
        ...(input.nowMs === undefined ? { at: "1970-01-01T00:00:00.000Z" } : {}),
        // The CLI has a provider, so its default can author a model summary;
        // explicit extractive retains the provider-free primitive below.
        ...((input.compactSummary ?? DEFAULT_COMPACT_SUMMARY_MODE) === "model"
          ? { summarize: createModelSummarizer({ provider, model: input.model,
            ...(input.contextTokenLimit === undefined ? {} : { contextTokenLimit: input.contextTokenLimit }),
          }) }
          : {}),
      }),
      // Injected only when the switch asked for it. Absent means the loop never
      // ticks the subsystem: no beat reported, no slot compiled, no text held
      // back (I1).
      ...(method === undefined ? {} : { method }),
      // Independent of the method slot above: tool learning is its own
      // subsystem with its own fence. Absent means the loop never asks for a
      // self-report and holds nothing back (I1).
      ...(input.toolGap === undefined ? {} : { toolGap: input.toolGap.port }),
      // Mid-run input (WP08). Absent — every default path — means the loop
      // never asks, and a turn is byte for byte the turn it always was.
      ...(input.pendingInput === undefined ? {} : { pendingInput: input.pendingInput }),
      // Undo, bound for real: one snapshot per turn, before the first write.
      ...(input.checkpointRoot === undefined
        ? {}
        : {
            checkpoint: checkpointWiring({
              workspaceRoot,
              storageRoot: input.checkpointRoot,
              nowMs: input.nowMs ?? 0,
              ...(input.nowMs === undefined ? { at: "1970-01-01T00:00:00.000Z" } : {}),
            }),
          }),
    },
    toolCatalogHash: toolCatalogHash(finalTools, input.toolSelection),

    close: async () => {
      try {
        await subagentRuntime?.cancelAll();
      } finally {
        try {
          try { try { await centralLearning?.close(); } finally { await collaboration?.close(); } }
          finally { await lsp.languageServers?.closeAll(); }
        } finally {
          try { if (input.execution === undefined) await execution.close(); }
          finally { images?.close(); }
        }
      }
    },

    providerId: input.providerId,
    model: input.model,
    ...(subagentRuntime !== undefined ? { subagentRuntime } : {}),
    ...(permissionLedger === undefined ? {} : { permissionLedger }),
  };
}
