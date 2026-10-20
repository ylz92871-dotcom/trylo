import type { ToolCallRequest, ToolOutcome, ToolPort, ToolSandbox } from "../../ports/tools.js";
import type { ShellSpawner } from "./mutating/shell-spawn.js";
import { createMutatingTools, type ToolVisibility } from "./mutating/index.js";
import { APPLY_PATCH_TOOL, EDIT_FILE_TOOL, NOTEBOOK_EDIT_TOOL, RUN_SHELL_TOOL, WRITE_FILE_TOOL } from "./mutating/names.js";
import {
  LIST_PROCESSES_TOOL,
  STOP_PROCESS_TOOL,
  WRITE_STDIN_TOOL,
  createProcessSessionTools,
} from "./mutating/process-session-tools.js";
import type { ProcessSessionRegistry } from "../process-session/session-registry.js";
import { resolvePtyHelper } from "../process-session/pty-loader.js";
import { createReadOnlyTools } from "./read-only/index.js";
import type { LocalRuleLookup } from "../project-instructions/appendix.js";
import { createNodeFileSystemReader } from "./read-only/node-fs.js";
import { describeToolExecution } from "./execution-description.js";
import type { ValidatedImageReferenceSink } from "../../ports/image-reference-access.js";
import { createLspTools } from "./lsp-tools.js";
import { LSP_TOOL } from "./lsp-names.js";
import type { LanguageServerPool } from "../language-server/registry.js";
import type { ShellModeResult } from "../sandbox/shell-mode.js";
import { createAskUserTools, type AskUserSession } from "./ask-user/index.js";
import { createPlanModeCell, createPlanTools } from "./plan/index.js";
import { createWorkflowTools, WORKFLOW_TOOL_NAMES } from "./workflow-history.js";
import type { SessionRecord } from "../../ports/session.js";
import { WEB_TOOL_NAMES } from "./web/names.js";
import { createWebTools, type WebToolsConfig } from "./web/index.js";
import { MEMORY_TOOL_NAMES, createMemoryTools } from "./memory/index.js";
import { MEMORY_WRITE_TOOL_NAMES, createMemoryWriteTools } from "./memory/write.js";
import type { MemoryReadPort } from "../../ports/memory.js";
import type { UserMemoryService } from "../../integration/user-learning/index.js";
import { SKILL_TOOL_NAMES, createSkillTools } from "./skill/index.js";
import type { SkillCatalogPort, SkillForkExecutor } from "../../ports/skills.js";

/**
 * One catalog for a workspace.
 *
 * Mutating tools are only advertised when there is a sandbox to bound them.
 * Offering a tool that cannot legally run is worse than not offering it: the
 * model would keep asking for something every layer has already decided to
 * refuse, which turns a clear failure into a loop.
 */

export type WorkspaceToolsConfig = {
  readonly onImageValidated?: ValidatedImageReferenceSink;
  readonly workflowRecords?: readonly SessionRecord[];
  readonly turnId?: string;
  readonly questions?: AskUserSession;
  readonly workspaceRoot: string;
  readonly sandbox?: ToolSandbox;
  readonly spawner?: ShellSpawner;
  readonly visibility?: ToolVisibility;
  /**
   * `--allow-web` 的落地处：true 才挂载网络工具。Absent/false 时目录里
   * 根本没有它们，catalog 哈希与从未听说过网络工具的从前逐字相同（R1）。
   *
   * 开关与后端是两件事：`allowWeb` 决定「这次运行被允许联网」，`web` 里的
   * `search` 决定「有没有东西能真的搜」。两者都真才挂 `web_search`。
   */
  readonly allowWeb?: boolean;
  /** 网络工具的后端（WP20）。Absent 时只有 `web_fetch` 的默认能力。 */
  readonly web?: WebToolsConfig;
  /**
   * 项目局部规则的发现接点（WP-CLI-B1 §3.1）。Absent —— 每一条默认路径 ——
   * `read_file` 的结果与从前逐字相同，连一个字段都不多。
   *
   * 传进来而不是在这里构造：构造需要一个 reader 和一份「本轮已经装了哪些规则」
   * 的事实，而这两样只有 CLI 组装根知道（`run-command.ts` 读盘、host 冻结本轮）。
   */
  readonly localRules?: LocalRuleLookup;
  /**
   * The process-session registry these tools observe. Injected rather than
   * constructed here so that a caller which started commands elsewhere — and a
   * test — can hand over the same one. Absent means the tools are not mounted,
   * so a catalog that never had sessions cannot pretend to have them.
   */
  readonly sessions?: ProcessSessionRegistry;
  /**
   * Language servers for this project, WP12.2.
   *
   * Absent — the shipped default — means no `lsp_navigate` in the catalog at
   * all, and no language server process can exist. That is the whole point of
   * the cost contract: a plain `trylo` run must not spawn a type checker. The
   * caller supplies the pool because the *process* is its to own, and a tool
   * that could start and stop servers on its own would be deciding something
   * that belongs to the session.
   */
  readonly languageServers?: LanguageServerPool;
  /**
   * The run's shell mode (WP05 C06/C07). Absent is the direct path; only the
   * mutating half reads it, so read-only runs never hear of interpreters.
   */
  readonly shellMode?: ShellModeResult;
  /**
   * 本次运行可检索的记忆记录（WP20.3: C60/L51）。Absent —— 每一条默认路径 ——
   * 意味着目录里没有 `memory_search`/`memory_read`，catalog 哈希逐字不变。
   *
   * 传端口而不传路径/board：读什么、怎么读，由已经拥有那些记录的调用方回答。
   * 这里若自己去开 board，就会变成学习控制面旁边第二个读者，而「我学到了什么」
   * 会开始有两个答案。
   */
  readonly memory?: MemoryReadPort;
  /**
   * 正式用户记忆的写入口（WP-CL / B）。Absent —— 所有非学习路径 —— 目录里
   * 没有 `memory_remember`/`memory_forget`，catalog 与从前逐字相同。
   *
   * 只在 `--learning` 允许用户学习时由组合根提供：关闭时模型手里没有任何可以
   * 声称"已保存"的工具，也就无法用一次文件写入冒充记忆。
   */
  readonly memoryWrite?: UserMemoryService;
  /**
   * 已安装技能目录（WP14.1/C51）。Absent —— 工作区与用户层都没有技能 ——
   * 目录里没有 `skill` 工具，catalog 哈希与从未听说过技能的从前逐字相同。
   *
   * 传的是按轮冻结的 catalog 快照：卸载 = 下一轮不再被构造，不需要任何清理。
   */
  readonly skills?: SkillCatalogPort;
  /**
   * `context: fork` 技能的委托出口（WP14.3）。由 wiring 挂到子代理端口上；
   * absent 时 fork 技能以 `skill_fork_unavailable` 终局，绝不静默内联执行。
   */
  readonly skillFork?: SkillForkExecutor;
};

const MUTATING_NAMES = new Set<string>([WRITE_FILE_TOOL, EDIT_FILE_TOOL, APPLY_PATCH_TOOL, NOTEBOOK_EDIT_TOOL, RUN_SHELL_TOOL]);

/**
 * Session tools, and why they are mounted outside the sandbox.
 *
 * `write_stdin`/`list_processes`/`stop_process` cannot start anything — they
 * only act on a command that already exists. Hanging them off the sandbox would
 * mean a run in `read_only` could not check on a command it was allowed to
 * have started earlier, and the failure would look like the sandbox refusing
 * something it had already permitted.
 *
 * The registry lives in this closure, so it has the same lifetime as the catalog
 * that can reach it. `sessions` is a seam: production passes the real registry,
 * tests pass their own.
 */
const WP21_ASK_NAMES = new Set<string>([
  "ask_user_question",
  "answer_user_question",
  "request_user_input_async",
  "send_message_to_user_async",
]);

const WP21_PLAN_NAMES = new Set<string>(["enter_plan_mode", "exit_plan_mode", "update_plan"]);

const SESSION_TOOL_NAMES = new Set<string>([WRITE_STDIN_TOOL, LIST_PROCESSES_TOOL, STOP_PROCESS_TOOL]);

export function createWorkspaceTools(config: WorkspaceToolsConfig): ToolPort {
  const policy = config.sandbox?.policy;
  const executionDescription = { ...config, ...(policy?.fileAccess === undefined ? {} : { fileAccess: policy.fileAccess }) };
  const readOnly = createReadOnlyTools({
    ...(config.onImageValidated === undefined ? {} : { onImageValidated: config.onImageValidated }),
    workspaceRoot: policy?.workspaceRoot ?? config.workspaceRoot,
    ...(policy?.workspaceAlias === undefined ? {} : { workspaceAlias: policy.workspaceAlias }),
    ...(policy?.fileAccess === undefined ? {} : { fileAccess: policy.fileAccess }),
    reader: createNodeFileSystemReader(),
    ...(config.localRules === undefined ? {} : { localRules: config.localRules }),
  });
  // The task list lives in this closure for the life of the catalog: no file,
  // no network, so it joins the read-only half and needs no sandbox to exist.
  const workflow = createWorkflowTools(config.workflowRecords, config.turnId);
  // WP21: user questions, plan mode, persistent tasks, and goals. All four
  // are read-only records (no workspace mutation, no network), so they ride
  // the read-only half like todo_write and need no sandbox to exist. The
  // catalog hash moves once when they land; older sessions resume with
  // `--migrate catalog`.
  //
  // Plan mode is mechanical, not advisory: the cell below is the one plan
  // state per catalog. The plan port moves it, and the dispatcher below
  // refuses every mutating tool while it is not `working` — entering plan
  // mode and then mutating is refused with a named code, not merely
  // discouraged by prompt text.
  const askUser = config.questions ?? createAskUserTools();
  const planCell = createPlanModeCell();
  const plan = createPlanTools({ cell: planCell });
  // Absent by default: only a run that typed `--allow-web` builds this port at
  // all, so the flag-off catalog is the old object, not an equal-looking new one.
  const web = config.allowWeb === true ? createWebTools(config.web) : undefined;
  // Absent unless a caller lent a port: a run with no records to search has no
  // memory tools, and says nothing about memory rather than answering "no
  // matches" forever.
  const memory = config.memory === undefined ? undefined : createMemoryTools(config.memory);
  // Same absent-means-off rule as the read half: a run that cannot save must not
  // offer a tool that could appear to save.
  const memoryWrite = config.memoryWrite === undefined ? undefined : createMemoryWriteTools(config.memoryWrite);
  // Absent unless a catalog was lent: a run with no installed skills keeps the
  // old catalog byte for byte, including its hash.
  const skills =
    config.skills === undefined ? undefined : createSkillTools(config.skills, config.skillFork);
  // Present only when a registry is supplied. A run that never starts a
  // long-lived command gets the old catalog byte for byte.
  const sessionTools =
    config.sessions === undefined
      ? undefined
      : createProcessSessionTools({
          write: (request) => config.sessions!.write(request),
          list: () => config.sessions!.list(),
          stop: (sessionId) => config.sessions!.stop(sessionId),
          supportsTty: resolvePtyHelper().ok,
        });
  const mutating =
    config.sandbox === undefined
      ? undefined
      : createMutatingTools({
          sandbox: config.sandbox,
          // The run's interpreter decision reaches the planner, never the
          // binding: a `shell` that changed the catalog hash would refuse old
          // sessions, so it travels beside the tools instead of inside them.
          ...(config.shellMode === undefined ? {} : { shellMode: config.shellMode }),
          // The same registry the session tools observe. `runInBackground`
          // starting a session nothing can then reach would make the feature
          // work and be unusable at the same time.
          ...(config.sessions === undefined ? {} : { sessions: config.sessions }),
          ...(config.spawner === undefined ? {} : { spawner: config.spawner }),
          ...(config.visibility === undefined ? {} : { visibility: config.visibility }),
        });
  // Absent unless a caller supplied servers: no pool means no tool, no process,
  // and no entry in the catalog hash.
  const nodeReader = createNodeFileSystemReader();
  const lsp =
    config.languageServers === undefined
      ? undefined
      : createLspTools(config.languageServers, {
          workspaceRoot: config.workspaceRoot,
          readDocument: async (absolutePath, signal) => {
            try {
              return await nodeReader.readFileUtf8(absolutePath, signal);
            } catch {
              // A file that cannot be read is not a reason to fail the query: the
              // server may still know the project from its own index, and the
              // answer it gives will say whether it could. One `catch` with one
              // stated outcome, rather than a branch per failure kind.
              return undefined;
            }
          },
        });
  return {
    snapshot() {
      const readOnlyCatalog = [
        ...readOnly.snapshot(),
        ...workflow.snapshot().filter(binding => binding.name === "todo_write"),
        ...askUser.snapshot(),
        ...plan.snapshot(),
        ...workflow.snapshot().filter(binding => binding.name !== "todo_write"),
      ];
      const withMemory = memory === undefined ? readOnlyCatalog : [...readOnlyCatalog, ...memory.snapshot()];
      const withMemoryWrite = memoryWrite === undefined ? withMemory : [...withMemory, ...memoryWrite.snapshot()];
      const withSkills = skills === undefined ? withMemoryWrite : [...withMemoryWrite, ...skills.snapshot()];
      const mounted =
        web === undefined ? withSkills : [...withSkills, ...web.snapshot()];
      const withSessions =
        sessionTools === undefined ? mounted : [...mounted, ...sessionTools.bindings];
      const withLsp = lsp === undefined ? withSessions : [...withSessions, ...lsp.snapshot()];
      const catalog = mutating === undefined ? withLsp : [...withLsp, ...mutating.snapshot()];
      return catalog.filter(binding => config.visibility?.isDenied(binding.name) !== true)
        .map(binding => describeToolExecution(binding, executionDescription));
    },
    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      if (config.visibility?.isDenied(call.name) === true) return { outcome: "error", code: "permission_denied", message: `${call.name} is disabled for this session` };
      if (WORKFLOW_TOOL_NAMES.has(call.name)) {
        return workflow.execute(call, signal);
      }
      if (WP21_ASK_NAMES.has(call.name)) {
        return askUser.execute(call, signal);
      }
      if (WP21_PLAN_NAMES.has(call.name)) {
        return plan.execute(call, signal);
      }
      // Plan-mode gate (WP21.2/B2): while the plan cell is not `working`,
      // workspace mutation is refused with a named code before sandbox,
      // permission, or execution is ever consulted. Planning tools
      // (ask/plan/tasks/goals) stay reachable — planning is the job — but a
      // `write_file` or `run_shell` inside plan mode is a refusal, not advice.
      if (planCell.current.kind !== "working" && mutating !== undefined && MUTATING_NAMES.has(call.name)) {
        return {
          outcome: "error",
          code: "plan_mode_denies_mutation",
          message: `plan mode is ${planCell.current.kind}; exit plan mode with user approval before mutating the workspace`,
        };
      }
      if (memory !== undefined && MEMORY_TOOL_NAMES.has(call.name)) {
        return memory.execute(call, signal);
      }
      if (memoryWrite !== undefined && MEMORY_WRITE_TOOL_NAMES.has(call.name)) {
        return memoryWrite.execute(call, signal);
      }
      if (skills !== undefined && SKILL_TOOL_NAMES.has(call.name)) {
        return skills.execute(call, signal);
      }
      // Dispatched by set rather than by one name: `web_search` is only in the
      // catalog when a backend was lent, and a name check written for one tool
      // would silently stop reaching the other.
      if (web !== undefined && WEB_TOOL_NAMES.has(call.name)) {
        return web.execute(call, signal);
      }
      if (sessionTools !== undefined && SESSION_TOOL_NAMES.has(call.name)) {
        return sessionTools.execute(call);
      }
      if (lsp !== undefined && call.name === LSP_TOOL) {
        return lsp.execute(call, signal);
      }
      if (mutating !== undefined && MUTATING_NAMES.has(call.name)) {
        return mutating.execute(call, signal);
      }
      return readOnly.execute(call, signal);
    },
    async cancel(toolCallId: string): Promise<void> {
      await readOnly.cancel(toolCallId);
      await workflow.cancel(toolCallId);
      await askUser.cancel(toolCallId);
      await plan.cancel(toolCallId);
      if (web !== undefined) {
        await web.cancel(toolCallId);
      }
      if (memory !== undefined) {
        await memory.cancel(toolCallId);
      }
      if (memoryWrite !== undefined) {
        await memoryWrite.cancel(toolCallId);
      }
      if (skills !== undefined) {
        await skills.cancel(toolCallId);
      }
      if (lsp !== undefined) {
        await lsp.cancel(toolCallId);
      }
      if (mutating !== undefined) {
        await mutating.cancel(toolCallId);
      }
    },
  };
}
