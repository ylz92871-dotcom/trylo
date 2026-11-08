import type { CliContext } from "../context.js";
import { prepareConnectionDraft, type ConnectionDraft } from "../connection-draft.js";
import { probeConnection } from "../connection-probe.js";
import { saveConnection, type ConnectionSaveResult } from "../connection-save.js";
import type { TuiIo } from "./io.js";
import { choose } from "./choose.js";
import { wrapLine } from "./frame.js";
import { tryloHome } from "../session-paths.js";

export type ConnectionFormResult = ConnectionSaveResult & { readonly useNow?: true };

/** Draft edits are memory-only until the operator chooses a save action. */
export async function reviewConnection(ctx: CliContext, io: TuiIo, initial: ConnectionDraft): Promise<ConnectionFormResult | undefined> {
  let draft = initial;
  let verification = "未验证";

  for (;;) {
    const prepared = prepareConnectionDraft(ctx, draft);
    const summary = ["连接草稿", `名称：${draft.id}`, `请求地址：${prepared.ok ? prepared.declaration.endpoint : draft.address}`,
      `模型：${draft.model}`, `凭据：${draft.credential.kind === "secret" ? "********" : draft.credential.kind}`,
      `验证：${verification}`, `保存位置：${tryloHome(ctx.homeDir, ctx.env)}`];

    io.write(`${summary.flatMap(row => wrapLine(row, Math.max(10, io.size().columns - 1))).join("\n")}\n`);

    if (!prepared.ok) io.write(`请修改草稿：${prepared.code}: ${prepared.detail}\n`);

    const action = await choose(io, { title: "连接操作 · Esc 取消，草稿不会保存", items: [
      { id: "use", label: "保存为默认并使用", detail: "开启新会话，原会话保留" },
      { id: "save", label: "仅保存", detail: "当前会话和默认选择不变" },
      { id: "verify", label: "验证连接", detail: "仅验证文本连接，不保存" },
      { id: "edit", label: "编辑草稿" },
    ] });
    if (action === undefined) return undefined;

    if (action === "edit") {
      const edited = await editDraft(ctx, io, draft);
      if (edited !== undefined) {
        draft = edited;
        verification = "未验证";
      }
      continue;
    }

    if (!prepared.ok) continue;

    if (action === "verify") {
      io.write(`正在验证 ${prepared.declaration.endpoint} · ${draft.model}\n`);
      const result = await probeConnection(ctx, draft);
      verification = result.ok ? `文本连接可用 · ${result.durationMs}ms` : `失败：${result.code} · ${result.durationMs}ms`;
      io.write(`${verification}${result.ok ? "" : ` · ${result.detail}`}\n`);
      continue;
    }

    const result = saveConnection(ctx, draft, action === "use");

    return action === "use" ? { ...result, useNow: true } : result;
  }
}

async function editDraft(ctx: CliContext, io: TuiIo, draft: ConnectionDraft): Promise<ConnectionDraft | undefined> {
  const field = await choose(io, { title: "修改哪个字段？", items: [
    ...(draft.operation === "add" ? [{ id: "id", label: "连接 ID" }] : []),
    { id: "address", label: "服务地址" }, { id: "model", label: "模型 ID" },
    { id: "window", label: "上下文窗口" }, { id: "secret", label: "更换 API Key" },
  ] });
  if (field === undefined) return undefined;

  if (field === "secret") {
    const secret = await ctx.readSecret();
    return secret === undefined ? undefined : { ...draft, credential: { kind: "secret", secret } };
  }

  const value = await io.readLine("输入新值（/cancel 返回）： ");
  if (value === undefined || value.trim() === "/cancel") return undefined;

  if (field === "id") return { ...draft, id: value.trim() };

  if (field === "model") return { ...draft, model: value.trim() };

  if (field === "address") {
    const kind = await choose(io, { title: "地址类型", items: [{ id: "base-url", label: "Base URL" }, { id: "endpoint", label: "完整 chat/completions 地址" }] });
    return kind === undefined ? undefined : { ...draft, address: value.trim(), addressKind: kind === "base-url" ? "base-url" : "endpoint" };
  }

  const count = Number(value.trim());
  if (!Number.isInteger(count) || count <= 0) {
    io.write("上下文窗口需为正整数。\n");
    return undefined;
  }

  return { ...draft, contextWindow: count };
}
