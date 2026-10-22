import type { PermissionPort } from "../../ports/permission.js";
import { workspaceWriteToolNames } from "./wiring.js";
import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import {
  createAllowToolsPermission,
  createDenyAllPermission,
  createInteractivePermission,
} from "./permission.js";
import { createPlannedPermission, planPermissions, type PermissionChoice } from "./permission-plan.js";
import { workspaceWriteAllowed } from "./workspace-write-approval.js";

/**
 * 一次运行用哪个 PermissionPort（D7）。
 *
 * 从 `run-command.ts` 机械外移，理由是 §10 #25 的 400 行硬门：外移只搬位置，
 * 不改变任何一个分支的判据。这里的边界值得单独写下来，因为它是「权限栈在哪」的
 * 唯一答案：
 *
 *  - 沙箱先放行（`adapters/sandbox`，任何旗都抢不到它前面）；
 *  - 然后才是这四个分支——交互式、`--allow-writes`、默认拒绝、以及显式策略
 *    （`--ask` / `--allow-tools` / `--deny-tools`）；
 *  - **持久 Permission 账本（`--permission-ledger`）不在这条链上**：账本记录的是
 *    工具包获取授权（`ApprovalConsumptionPort` 的 acquire/modify/activate/contribute），
 *    与「这一次工具调用准不准」是两套事实。把调用级审批塞进那本账需要伪造
 *    candidateId / packageVersionId，且账本的单次消费语义会把 session 级批准变成
 *    第二次即拒绝。见 `docs/.../DEFERRED-库存接线总技术规格.md` §7 W1 的修正记录。
 */

export function permissionChoice(options: RunCommandOptions): PermissionChoice {
  return {
    ...(options.allowWrites === true ? { allowWrites: true } : {}),
    ...(options.ask === undefined ? {} : { ask: options.ask }),
    ...(options.allowTools === undefined ? {} : { allowTools: options.allowTools }),
    ...(options.denyTools === undefined ? {} : { denyTools: options.denyTools }),
  };
}

/** True when a request names a policy the pre-D7 code had no way to express. */
function usesPermissionEntry(choice: PermissionChoice): boolean {
  return choice.ask !== undefined || choice.allowTools !== undefined || choice.denyTools !== undefined;
}

/**
 * Non-interactive runs have nobody to ask, so the default is denial.
 * `--allow-writes` is the one widening, and it widens to the tools that declare
 * a `workspace_write` side effect only: `run_shell` still needs a human.
 *
 * When no permission flag is given the three original ports are used verbatim,
 * rather than being routed through the planned one. The planned port would
 * decide the same things, but "the default path is unchanged" is a promise
 * about this process, not about its conclusions, so it is kept literally.
 */
export function permissionFor(
  permissionMode: "interactive" | "non_interactive",
  ctx: CliContext,
  choice: PermissionChoice,
  workspaceRoot: string = ctx.cwd,
): PermissionPort {
  if (!usesPermissionEntry(choice)) {
    if (permissionMode === "interactive") {
      return createInteractivePermission(permissionIo(ctx));
    }
    if (choice.allowWrites === true) {
      return createAllowToolsPermission(workspaceWriteToolNames(), action => workspaceWriteAllowed(workspaceRoot, action));
    }
    return createDenyAllPermission();
  }
  return createPlannedPermission(
    planPermissions({ ...choice, interactive: permissionMode === "interactive" }),
    permissionIo(ctx),
    action => workspaceWriteAllowed(workspaceRoot, action),
  );
}

export function permissionIo(ctx: CliContext) {
  return { prompt: (text: string) => ctx.stderr(text), readLine: ctx.readLine, ...ctx.approval };
}
