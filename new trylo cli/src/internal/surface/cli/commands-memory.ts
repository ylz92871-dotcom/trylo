import path from "node:path";
import { existsSync } from "node:fs";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import type { MemoryImportOptions } from "./args-memory.js";
import { createFileFactStore, importLegacyFacts, decodeLegacyDocument, deleteUserMemory } from "../../integration/user-learning/index.js";
import { USER_FACTS_FILE } from "../../integration/user-learning/facts-file.js";
import { USER_LEDGER_FILE } from "../../integration/user-learning/ledger-file.js";
import { userLearningRoot } from "./user-learning-config.js";
import { visibleFacts } from "../../learning/domains/user/memory-fact.js";
import { decideScopeV2 } from "../../learning/domains/user/scope-v2.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { notifyUserDataDeleted } from "./central-runtime-user-delete-notify.js";

/**
 * `memory list|import`（WP-CL / B17）。
 *
 * `import` 不经过 grounding：旧记录没有"这一轮用户说了什么"，它被接受的唯一依据
 * 是导出的 `provenance`。缺来源的条目被原样留在旧处并**逐条报告原因**——静默跳过
 * 会让"导入了 12 条"和"实际生效 3 条"看起来一样。
 */

function storeFor(ctx: CliContext) {
  return createFileFactStore(userLearningRoot(ctx.homeDir, ctx.env));
}

/** Explicit local maintenance; preserves consumed command IDs and retraction tombstones. */
export function handleMemoryCompact(ctx: CliContext, options: { readonly json: boolean }): ExitCode {
  const result = storeFor(ctx).compact();

  if (options.json) ctx.stdout(`${JSON.stringify(result)}\n`);
  else if (result.ok) ctx.stdout(`compacted user memory: ${result.before} → ${result.after} records\n`);

  if (!result.ok) {
    ctx.stderr(`memory compact: ${result.reason}\n`);
    return EXIT_CODES.CONFIG;
  }

  return EXIT_CODES.OK;
}

export function handleMemoryList(ctx: CliContext, options: { readonly json: boolean }): ExitCode {
  const read = storeFor(ctx).read();
  if (!read.ok) {
    ctx.stderr(`memory list: ${read.reason}\n`);
    return EXIT_CODES.CONFIG;
  }

  if (read.unreadable > 0) {
    ctx.stderr("memory list: facts_corrupt\n");
    return EXIT_CODES.CONFIG;
  }

  const workspaceId = workspaceIdentity(ctx.cwd);
  const facts = visibleFacts(read.records, { userId: decideScopeV2({ workspaceId }).identity.userId, workspaceId });

  if (options.json) {
    ctx.stdout(`${JSON.stringify({ facts })}\n`);
    return EXIT_CODES.OK;
  }

  if (facts.length === 0) {
    ctx.stdout("no user memory saved on this machine\n");
    return EXIT_CODES.OK;
  }

  for (const fact of facts) {
    const scope = fact.scope.kind === "user" ? `user:${fact.scope.userId}` : `project:${fact.scope.workspaceId}`;
    ctx.stdout(`${fact.id} v${fact.version}  [${fact.factKind}/${scope}]  ${fact.subject}：${fact.statement}\n`);
  }

  if (read.unreadable > 0) ctx.stderr(`memory list: ${read.unreadable} unreadable line(s) ignored\n`);

  return EXIT_CODES.OK;
}

export function handleMemoryImport(ctx: CliContext, options: MemoryImportOptions): ExitCode {
  const absolute = path.isAbsolute(options.file) ? options.file : path.join(ctx.cwd, options.file);
  const raw = ctx.readFile(absolute);
  if (raw === undefined) {
    ctx.stderr(`memory import: cannot read ${absolute}\n`);
    return EXIT_CODES.CONFIG;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    ctx.stderr("memory import: the file is not valid JSON\n");
    return EXIT_CODES.CONFIG;
  }

  const document = decodeLegacyDocument(parsed);
  if (!document.ok) {
    ctx.stderr(`memory import: ${document.reason}\n`);
    return EXIT_CODES.CONFIG;
  }

  const store = storeFor(ctx);
  const decisions = importLegacyFacts(store, document.value.facts, () => ctx.now());
  const imported = decisions.filter((decision) => decision.outcome === "imported").length;
  const already = decisions.filter((decision) => decision.outcome === "already").length;
  const skipped = decisions.filter((decision) => decision.outcome === "skipped").length;

  if (options.json) {
    ctx.stdout(`${JSON.stringify({ imported, already, skipped, decisions })}\n`);
    return EXIT_CODES.OK;
  }

  ctx.stdout(`imported ${imported}, already present ${already}, left in place ${skipped}\n`);

  for (const decision of decisions) {
    if (decision.outcome === "skipped") {
      ctx.stdout(`  kept ${decision.legacyId}: ${decision.reason}\n`);
    } else {
      ctx.stdout(`  ${decision.outcome} ${decision.legacyId} → ${decision.recordId} v${decision.version}\n`);
    }
  }

  // Anything left unreadable is reported but never blocks the import: a torn
  // line in the middle of the ledger must not make the whole migration fail.
  const after = store.read();
  if (after.ok && after.unreadable > 0) ctx.stderr(`memory import: ${after.unreadable} unreadable line(s)\n`);

  return EXIT_CODES.OK;
}

/**
 * `memory delete --all --yes`（B20）。
 *
 * 删除成功之后**再读一次**：读得到就报失败。这一步不是仪式——它证明的是
 * "文件真的没了"，而不是"`rm` 没抛异常"。
 */
export async function handleMemoryDelete(
  ctx: CliContext,
  options: { readonly all: boolean; readonly json: boolean },
): Promise<ExitCode> {
  if (!options.all) {
    ctx.stderr("memory delete: refusing to delete anything without --all\n");
    return EXIT_CODES.USAGE;
  }

  const root = userLearningRoot(ctx.homeDir, ctx.env);
  const deleted = deleteUserMemory(root);
  if (!deleted.ok) {
    ctx.stderr(`memory delete: ${deleted.reason}\n`);
    return EXIT_CODES.CONFIG;
  }

  if (existsSync(path.join(root, USER_FACTS_FILE))) {
    ctx.stderr("memory delete: the facts file is still readable after deletion\n");
    return EXIT_CODES.CONFIG;
  }

  if (existsSync(path.join(root, USER_LEDGER_FILE))) {
    ctx.stderr("memory delete: the User ledger is still readable after deletion\n");
    return EXIT_CODES.CONFIG;
  }

  const notification = await notifyUserDataDeleted(ctx);
  if (notification.status === "unconfirmed") {
    try { ctx.stderr("memory delete: data removed; learning notification unconfirmed\n"); }
    catch { /* A diagnostic failure cannot reverse deletion or suppress its JSON receipt. */ }
  }

  if (options.json) {
    ctx.stdout(`${JSON.stringify({ removed: deleted.removed, absent: deleted.absent, notification })}\n`);
    return EXIT_CODES.OK;
  }

  ctx.stdout(deleted.removed.length === 0
    ? "nothing to delete: no user memory saved on this machine\n"
    : `deleted ${deleted.removed.join(", ")}\n`);

  return EXIT_CODES.OK;
}

