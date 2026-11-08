import { readFileSync } from "node:fs";

import { selectProvider } from "../../internal/adapters/provider/registry.js";
import { isKeyedProviderKind } from "../../internal/adapters/provider/providers-file.js";
import { createLoopWorkerExecutor } from "../../internal/integration/worker/loop-executor.js";
import type { WorkerExecutionOwner } from "../../internal/ports/worker.js";
import {
  createCliCredentialPort,
  resolveNamedProviderCredential,
  resolveProviderCredential,
} from "../../internal/surface/cli/credentials-wiring.js";
import {
  createAllowToolsPermission,
  createDenyAllPermission,
} from "../../internal/surface/cli/permission.js";
import {
  isDocumentFailure,
  readCliProviderRegistry,
} from "../../internal/surface/cli/providers-wiring.js";
import { wirePorts } from "../../internal/surface/cli/wiring.js";
import { reasoningSummaryOptions } from "../../internal/surface/cli/provider-build.js";

/**
 * 后台 worker 的执行器装配（WP26 / A04「通电」）。
 *
 * ## 它回答的唯一问题
 *
 * 队列里那句话，到底由谁跑。答案是**现有的 loop runner**（`loop/runner.ts::
 * runTurn`）—— 本仓库「跑一轮」只有一个实现，这里不另造一个执行总管，只做两件
 * 事：把这台机器上选中的 provider 找出来，把 `LoopPorts` 组装好，然后交给
 * `integration/worker/loop-executor.ts` 翻译成 worker 的执行 owner。
 *
 * ## 为什么单独一个文件
 *
 * `daemon-main.ts` 已经 277 行，而装配需要读 providers、读凭据、选权限端口，
 * 三件事各有各的失败方式。塞进 daemon-main 会让它同时承担「进程入口」和「组合
 * 根」两个角色，而这两个角色在本仓库是分开的（组合根是 `surface/cli/wiring.ts`）。
 *
 * ## 为什么失败一律返回「不开工」
 *
 * 一个装配不出来的执行器如果被换成一个假执行器，后果不是「后台没跑」，而是
 * **队列被清空而任务没跑** —— 从外面看不出来，且不可恢复。所以这里任何一步失败
 * 都返回 `ok:false`，由 daemon 记一行日志并保持 worker 关闭；队列里的东西留着，
 * 等人来看。
 *
 * ## 它读的两个环境变量
 *
 * 与 `process-ambient.ts` 的约定一致：daemon 不在终端里，没有命令行参数可收，
 * 配置只能通过环境进来。两个变量都**缺省即关**：
 *
 *  - `TRYLO_DAEMON_PROVIDER` —— 用哪个 provider。不给就用 `providers.json`
 *    的 `selected`，再没有就用内置默认，判据与前台 `trylo run` 完全一致
 *    （`registry.ts::selectProvider`），不存在第二套优先级。
 *  - `TRYLO_DAEMON_ALLOW_TOOLS` —— 逗号分隔的工具名白名单。不给就是**全部拒绝**
 *    （`createDenyAllPermission`）：后台没有人在场回答，写操作一律不批。只读工具
 *    本来就不过审批门，所以「全拒」=「能读不能写」，这是 daemon 唯一诚实的缺省。
 */

/** 装配不出来的时候，为什么。写进 daemon 日志，也是给人看的唯一线索。 */
export type DaemonWorkerRefusal = { readonly ok: false; readonly reason: string };

export type DaemonWorkerBuild = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly cwd: string;
  readonly now: () => number;
  readonly newId: (prefix: string) => string;
};

/** 一个文件读不出来就当它不存在；providers 是可选的，读失败不是 daemon 的失败。 */
function readFileIfPresent(absolutePath: string): string | undefined {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}

/** 逗号分隔的工具名。空串、只有逗号、全是空白 —— 都等于「一个都没给」。 */
function allowedToolNames(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
}

export function buildDaemonWorkerExecutor(
  input: DaemonWorkerBuild,
): { readonly ok: true; readonly executor: WorkerExecutionOwner } | DaemonWorkerRefusal {
  const registry = readCliProviderRegistry({
    homeDir: input.homeDir,
    env: input.env,
    readFile: readFileIfPresent,
  });
  if (isDocumentFailure(registry)) {
    return { ok: false, reason: `providers document unreadable: ${registry.code} ${registry.detail}` };
  }

  const requested = input.env["TRYLO_DAEMON_PROVIDER"];
  const selected = selectProvider(registry, requested === undefined ? undefined : requested);
  if (!selected.ok) {
    return {
      ok: false,
      reason: `no such provider ${selected.denial.id}; known: ${selected.denial.known.join(", ")}`,
    };
  }

  const entry = selected.entry;

  // 端点与模型来自**同一个条目**，与前台 `resolveProvider` 同源。分开取就会出现
  // 「id 来自 A、端点来自 B」的半个 provider，那是 D3 明令禁止的形状。
  const endpoint = entry.capabilities.endpoint;
  const model = entry.model;

  // 需要 key 的家族才去动账本。fixture 家族不查账本，所以离线验收不需要凭据。
  let apiKey: string | undefined;

  if (isKeyedProviderKind(entry.kind)) {
    if (endpoint.length === 0) {
      return { ok: false, reason: `provider ${entry.id} has no endpoint; nothing to send a turn to` };
    }

    // 模型名是逐轮请求带的（见 `loop-executor.ts::workerTurnRequest`），空的名字
    // 打到端点只会换回一个 404 —— 不如在这里用一句人话拒掉。
    if (model.length === 0) {
      return { ok: false, reason: `provider ${entry.id} declares no model; set \`model\` in providers.json` };
    }

    const port = createCliCredentialPort({
      homeDir: input.homeDir,
      cwd: input.cwd,
      env: input.env,
      now: input.now,
    });
    // 与前台同一条规则：keyed 家族的凭据一律记在 `openai-compatible` 名下，
    // 声明里的 `accountId` 只是指定用哪个账号，不是第二个账本。
    const resolved =
      entry.accountId === undefined
        ? resolveProviderCredential(port, "openai-compatible")
        : resolveNamedProviderCredential(port, {
            providerId: "openai-compatible",
            accountId: entry.accountId,
          });
    if (!resolved.ok) {
      return { ok: false, reason: `credential for ${entry.id} unresolved: ${resolved.code}` };
    }

    if (resolved.apiKey === undefined) {
      return { ok: false, reason: `credential for ${entry.id} resolved to no key (layer ${resolved.layer})` };
    }

    apiKey = resolved.apiKey;
  }

  const allowed = allowedToolNames(input.env["TRYLO_DAEMON_ALLOW_TOOLS"]);
  const permission =
    allowed.size === 0 ? createDenyAllPermission() : createAllowToolsPermission(allowed);

  const wiring = wirePorts({
    providerId: entry.id,
    providerKind: entry.kind,
    ...reasoningSummaryOptions(entry),
    model,
    endpoint,
    apiKey,
    workspaceRoot: input.cwd,
    permission,
    nowMs: input.now(),
  });
  if ("code" in wiring) {
    return { ok: false, reason: `wiring refused: ${wiring.code} ${wiring.detail}` };
  }

  return {
    ok: true,
    executor: createLoopWorkerExecutor({
      ports: wiring.ports,
      // 取 `wiring.model` 而不是本地的 `model`：两者此刻相等，但「这一轮用哪个
      // 模型」的权威是组合根刚定下来的那个值，用它就不会将来某天与 wire 分家。
      model: wiring.model,
      now: input.now,
      newId: input.newId,
    }),
  };
}
