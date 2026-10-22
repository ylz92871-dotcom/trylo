import type { Message } from "../../contract/execution.js";
import { composeSandbox, composeTools } from "../../adapters/mcp-runtime/mount.js";
import { createFixtureProvider, DEFAULT_FIXTURE_SCRIPT } from "../../adapters/provider/fixture.js";
import type { TokenManagerLike } from "../../adapters/provider/openai-compatible.js";
import type { WarmRegistry } from "../../adapters/provider/warm.js";
import { buildProvider, kindOf } from "./provider-build.js";
import { SubagentRuntime } from "../../subagent/index.js";
import { buildSubagentPorts } from "./wiring-subagent.js";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { MEMORY_WRITE_TOOL_NAMES } from "../../adapters/tools/memory/write.js";
import { mountedWebToolNames } from "./web-wiring.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import type { ExecPolicyGuard } from "../../loop/tool-admission.js";
import { lspToolsPatch } from "./lsp-wiring.js";
import { createRunExecution } from "./run-execution-wiring.js";
import { composeLearningPorts } from "../../integration/user-learning/index.js";
import { createPermissionGrantCache, type PermissionGrantCache } from "../../loop/permission-grants.js";
import type { LoopPorts } from "../../loop/runner.js";
import type { PermissionPort } from "../../ports/permission.js";
import type { ToolPort } from "../../ports/tools.js";
import type { SessionRecord } from "../../ports/session.js";
import type { SkillCatalogPort } from "../../ports/skills.js";
import { createSkillForkExecutor } from "../../adapters/tools/skill/index.js";
import type { ProviderPort, ReasoningEffort } from "../../ports/provider.js";
import type { ProviderKind } from "../../adapters/provider/providers-file.js";
import { checkpointWiring } from "./checkpoint-wiring.js";
import { createModelSummarizer } from "./compact-model-summarizer.js";
import { createPageExtractor } from "./web-wiring.js";
import { compactionWiring, estimatePromptTokens } from "./compaction-wiring.js";
import { type WiringOptIns } from "./wiring-optins.js";
import {
  openPermissionLedger,
  type FilePermissionStore,
} from "./permission-ledger-wiring.js";
import { selectToolPort } from "./tool-selection.js";
import { methodPortOf } from "./wiring-method.js";
import { imageReferencesFor } from "./wiring-image-references.js";
import { restrictDeniedTools } from "./permission-tool-access.js";

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

export type WiringInput = {
  readonly execPolicy?: ExecPolicyGuard;
  readonly toolSelection?: readonly string[];
  readonly workflowRecords?: readonly SessionRecord[];
  readonly turnId?: string;
  readonly callerMessages?: ReadonlyArray<Message>;
  /** The selected id: a shipped one, or one declared in `providers.json`. */
  readonly providerId: string;
  /**
   * The adapter family, when it is not the id. Absent — every caller that
   * predates declared providers — means the id *is* the kind, which is true for
   * all four shipped ones; present, it is what a declared provider is built
   * from, so a provider named anything can still be the family it declares.
   */
  readonly providerKind?: ProviderKind;
  /** Explicit Responses summary support resolved before adapter construction. */
  readonly reasoningSummary?: "auto";
  readonly reasoningEffort?: ReasoningEffort;
  readonly model: string;
  readonly endpoint: string;
  /**
   * The resolved credential, when one resolved. It arrives already read by
   * `CredentialPort` (see `credentials-wiring.ts`); this file never reads an
   * environment variable or a ledger itself.
   */
  readonly apiKey: string | undefined;
  readonly tokenManager?: TokenManagerLike | undefined;
  /**
   * Which account the credential belongs to. It is part of a warm entry's
   * identity, never a credential: a session built for one account is not handed
   * to another.
   */
  readonly accountId?: string | undefined;
  /**
   * The warm layer, lent by a surface that runs more than one turn. Absent —
   * `trylo run`, every single-turn caller — means the provider is built exactly
   * as it always was and nothing is cached.
   */
  readonly warm?: WarmRegistry | undefined;
  readonly workspaceRoot: string;
  /**
   * Where snapshots are stored; must sit outside `workspaceRoot`. Absent
   * means a write runs with no undo, which is how every caller that never
   * asked for a profile root behaves.
   */
  readonly checkpointRoot?: string;
  readonly permission: PermissionPort;
  readonly grants?: PermissionGrantCache;
  /**
   * Milliseconds since the epoch, so a stored window carries a real host time.
   * Absent means the wiring is built without compaction, which is also what a
   * caller that never configures a ceiling wants.
   */
  readonly nowMs?: number;
  /**
   * The already-open MCP half of the tool table. Absent — which is every caller
   * that never asked for external tools — means the run is byte-identical to
   * one that never heard of them (WP §4-D8): the composite is not built, the
   * sandbox is the workspace's own, and the catalog hash is the same string.
   *
   * The sessions are opened by the caller because opening one is async and can
   * take a real handshake; this file is synchronous by design, and a wiring
   * that could block on a child process would be a wiring that can hang a CLI.
   */
  readonly mcp?: McpToolTable;
  /**
   * 按 WP14 冻结的技能目录（每轮由组合根重建）。Absent —— 工作区与用户层都
   * 没有技能 —— wiring 根本不构造 skill 工具，catalog 哈希逐字不变（R1）。
   */
  readonly skills?: SkillCatalogPort;
} & WiringOptIns;

/** An open MCP runtime, reduced to the two things a tool table is built from. */
export type McpToolTable = {
  readonly tools: ToolPort;
  /** Exactly the names that mounted; the composite sandbox admits only these. */
  readonly toolNames: ReadonlySet<string>;
};

export type WiringFailure = {
  readonly code: "missing_endpoint" | "unknown_provider" | "unsupported_reasoning_effort";
  readonly detail: string;
};

export type Wiring = {
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
  const sandbox = createWorkspaceSandbox({
    workspaceRoot: input.workspaceRoot,
    ...(input.fileAccess === undefined ? {} : { fileAccess: input.fileAccess }),
    // Same mode the tools will plan with: approval and execution plan twice
    // so they agree, never so they can disagree.
    ...(input.shellMode === undefined ? {} : { shellMode: input.shellMode }),
  });
  const images = imageReferencesFor(input);
  const provider = buildProvider({ ...input, workspaceRoot: sandbox.policy.workspaceRoot }, images?.read);
  if (isFailure(provider)) return provider;
  const grants = input.grants ?? createPermissionGrantCache();
  const method = composeLearningPorts({ method: methodPortOf(input), user: input.userLearning });
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
  const workspaceTools = restrictDeniedTools(selectToolPort(createWorkspaceTools({
    ...(input.workflowRecords === undefined ? {} : { workflowRecords: input.workflowRecords }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.questions === undefined ? {} : { questions: input.questions }),
    workspaceRoot: input.workspaceRoot,
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
  }), input.toolSelection), input.permission);
  // The composites. Both are identity-shaped when nothing was mounted, so
  // "MCP off" is the old objects rather than equal-looking new ones — the
  // difference a hash or a `===` would otherwise have to be trusted about.
  // The web tools join MCP's admission pattern, not the planner's: the workspace
  // planner refuses any name it has no plan for, so what admits a fetch is the
  // fact that it was *mounted*, never a global planner branch that would also
  // change how a flag-off run answers a hallucinated `web_fetch` call.
  const mcp = input.mcp;
  const tools = restrictDeniedTools(mcp === undefined ? workspaceTools : composeTools(workspaceTools, mcp.tools), input.permission);
  const webNames = mountedWebToolNames(workspaceTools);
  const memoryNames = workspaceTools.snapshot().filter((tool) => MEMORY_WRITE_TOOL_NAMES.has(tool.name)).map((tool) => tool.name);
  const admitted =
    webNames.length > 0 || memoryNames.length > 0 || mcp !== undefined
      ? new Set([...(mcp === undefined ? [] : mcp.toolNames), ...webNames, ...memoryNames])
      : undefined;
  const effectiveSandbox = admitted === undefined ? sandbox : composeSandbox(sandbox, admitted);

  let subagentRuntime: SubagentRuntime | undefined;
  let finalTools = tools;

  // 开关关闭时这里什么都不发生：不构造对象、不开文件、不建目录。构造本身是纯的
  // （`createFilePermissionStore` 只把路径与锁闭包记下来），真正的读取发生在
  // `host.ts` 的就绪校验里。
  const permissionLedger =
    input.permissionLedger === undefined ? undefined : openPermissionLedger(input.permissionLedger);

  if (isSubagentEnabled) {
    const built = buildSubagentPorts({
      parentTools: finalTools,
      workspaceTools,
      childProvider:
        kindOf(input) === "fixture-subagent"
          ? createFixtureProvider(DEFAULT_FIXTURE_SCRIPT)
          : provider,
      model: input.model,
      permission: input.permission,
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
    });
    subagentRuntime = built.runtime;
    // WP14：晚绑定的 fork 委托出口在这里闭合——skill 工具执行时，子代理端口
    // 已经存在。挂在同一个端口上，血统/治理/取消只有一份实现（WP22）。
    subagentToolPort = built.toolPort;
    finalTools = built.tools;
  }

  finalTools = selectToolPort(finalTools, input.toolSelection);

  return {
    ports: {
      provider,
      tools: finalTools,
      permission: input.permission,
      profile: NO_LEARNING_PROFILE,
      ...(input.execPolicy === undefined ? {} : { execPolicy: input.execPolicy }),
      sandbox: effectiveSandbox,
      grants,
      // Opted in only when the host lends a clock. The loop estimates the next
      // request itself; this estimator exists so a caller that supplies one
      // uses the same pure basis rather than a second, drifting one.
      compaction: compactionWiring({
        estimatePromptTokens: messages => estimatePromptTokens(messages) + (provider.continuation?.estimateOverheadTokens?.(messages) ?? 0),
        nowMs: input.nowMs ?? 0,
        ...(input.nowMs === undefined ? { at: "1970-01-01T00:00:00.000Z" } : {}),
        // Absent means the shipped extractive author, byte for byte as before.
        ...(input.compactSummary === "model"
          ? { summarize: createModelSummarizer({ provider, model: input.model }) }
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
              workspaceRoot: input.workspaceRoot,
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
          await lsp.languageServers?.closeAll();
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
