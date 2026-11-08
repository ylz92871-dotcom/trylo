import type { CliContext } from "./context.js";
import type { RunScaffold } from "./run-command.js";
import { connectionStatus, listConnections } from "./connection-status.js";
import { tryloHome } from "./session-paths.js";

/** Show the live scaffold separately from saved defaults; never print secrets. */
export function settingsText(ctx: CliContext, scaffold: RunScaffold): string {
  const status = connectionStatus(ctx);
  const connections = listConnections(ctx);
  const account = connections.ok ? connections.accounts.find(item => item.accountId === scaffold.accountId) : undefined;
  const lines = ["当前会话设置", `项目：${scaffold.workspaceRoot}`, `当前模型：${scaffold.providerId}/${scaffold.model}`,
    `请求地址：${scaffold.endpoint || "离线演示"}`, `账号：${account?.label ?? scaffold.accountId ?? "环境变量或无需凭据"}`,
    `权限：${scaffold.permissions?.snapshot().mode ?? "未提供"}`, `会话：${scaffold.sessionId}`,
    `用户配置：${tryloHome(ctx.homeDir, ctx.env)}`];

  if (status.kind === "failed") lines.push(`默认配置不可用：${status.failure.message}`);
  else {
    lines.push(`保存的选择：${status.provider.providerId}/${status.provider.model}`, `保存的请求地址：${status.provider.endpoint || "离线演示"}`);
    if (status.provider.providerId !== scaffold.providerId || status.provider.model !== scaffold.model || status.provider.endpoint !== scaffold.endpoint) {
      lines.push("保存的选择与当前会话不同；更换模型后才会用于新会话。");
    }
    for (const source of status.sources) if (source.path !== undefined && source.status === "loaded") lines.push(`配置来源：${source.path}`);
  }

  return `${lines.join("\n")}\n`;
}
