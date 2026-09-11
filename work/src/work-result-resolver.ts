// Trylo Work — WorkResultResolver.
//
// 2026-08-29 (Work end-to-end workflow redesign spec §10.2,
// §10.3): the single authority that turns a terminal Work
// turn's OBSERVED FACTS into the user-facing final answer.
//
// It exists to kill the forbidden fallback:
//   "任务已完成，未返回文本结论"
// A `completed` run must always land on a content-bearing
// final answer — the previous runtime's `projectTerminal`
// surfaced that placeholder string whenever the daemon's
// assistant final didn't arrive (spec §1.3). That is exactly
// the case this resolver repairs.
//
// Result priority (spec §10.2, mirroring the upstream
// `cron/result-text.js` semantics WITHOUT importing the CJS
// vendor into the browser bundle — this is the one Trylo
// copy, kept in sync with the upstream by contract tests):
//   1. the run's final assistant text (the `final` item)
//   2. a meaningful agent timeline narration
//   3. a text artifact preview
//   4. a deterministic completion summary built ONLY from
//      activities already observed (spec §10.3)
//
// Hard rules (spec §10.3 / §16):
//   - never fabricate file counts, verification verdicts or
//     artifacts;
//   - when no verification event was observed, say so —
//     never claim "通过";
//   - a trivial "完成" with no facts still returns at least a
//     neutral completion line, never the forbidden placeholder.

import type { WorkActivity, WorkTurnProjection } from "./work-domain.js";

/** Trivial / noise completions mirroring the upstream
 *  `TRIVIAL_PHRASES` — a terse "done" news must not win over
 *  a richer artifact summary. Kept small and in ONE place. */
const TRIVIAL: ReadonlySet<string> = new Set([
  "done",
  "done.",
  "complete",
  "complete.",
  "completed",
  "completed.",
  "完成",
  "已完成",
  "已完成。",
  "搞定",
]);

/** True when a candidate final text is empty, trivial or pure
 *  noise — i.e. NOT worth quoting as the final answer. */
export function isTrivialFinalText(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return true;
  if (TRIVIAL.has(t)) return true;
  if (t.startsWith("missing_final_answer")) return true;
  if (/<seed:tool_call\b|<tool_call\b|<function\s+name\s*=|"tool_(?:use|call)"\s*:/i.test(t)) {
    return true;
  }
  return false;
}

export interface ResolveOptions {
  readonly now?: () => number;
}

/** Resolve the final answer TEXT for a completed run. Falls
 *  back deterministically and never fabricates facts. */
export function resolveFinalAnswerText(
  projection: WorkTurnProjection,
  _opts?: ResolveOptions,
): string {
  // 1. Explicit final item text, when it is meaningful.
  const existing = projection.terminal;
  if (existing?.kind === "final_answer" && !isTrivialFinalText(existing.text)) {
    return existing.text.trim();
  }

  // 2. Last meaningful timeline narration.
  const lastNarration = projection.narrations
    .slice()
    .reverse()
    .find((n) => !isTrivialFinalText(n.text) && n.source !== "derived");
  if (lastNarration && lastNarration.text.length >= 2) {
    return lastNarration.text.trim();
  }

  // 3. A text artifact path as a thin preview.
  const artifact = projection.activities
    .slice()
    .reverse()
    .find((a) => a.kind === "artifact" && a.summary.length > 0);
  if (artifact) {
    return `已完成。已生成文件：${artifact.summary}。`;
  }

  // 4. Deterministic completion summary from observed facts.
  return buildDeterministicFallback(projection);
}

/** Spec §10.3: a factual completion summary. Uses ONLY facts
 *  already recorded on the projection — never guesses. */
export function buildDeterministicFallback(
  projection: WorkTurnProjection,
): string {
  const acts = projection.activities;
  const reads = sum(acts, "file_read");
  const writes = sum(acts, "file_write");
  const edits = sum(acts, "file_edit");
  const deletes = sum(acts, "file_delete");
  const commands = sum(acts, "command");
  const verifications = acts.filter((a) => a.kind === "verification");
  const artifacts = acts
    .filter((a) => a.kind === "artifact" && a.summary.length > 0)
    .map((a) => a.summary);

  const processed: string[] = [];
  if (reads > 0) processed.push(`读取 ${reads} 个文件`);
  if (writes > 0) processed.push(`创建 ${writes} 个文件`);
  if (edits > 0) processed.push(`修改 ${edits} 处`);
  if (deletes > 0) processed.push(`删除 ${deletes} 个文件`);
  if (commands > 0) processed.push(`执行 ${commands} 个命令`);
  if (processed.length === 0 && artifacts.length === 0) {
    // No facts at all — still a real terminal, never the
    // forbidden placeholder.
    return "已完成。";
  }

  const lines: string[] = ["已完成。"];
  if (processed.length > 0) lines.push(`- 处理：${processed.join("，")}`);
  if (artifacts.length > 0) lines.push(`- 产物：${Array.from(new Set(artifacts)).join("；")}`);

  // Verification: report only real evidence; otherwise be
  // honest that none was observed (spec §10.3).
  const passed = verifications.filter((v) => v.status === "completed");
  const failed = verifications.filter((v) => v.status === "failed");
  if (passed.length > 0) {
    lines.push(`- 验证：共 ${sum(acts, "verification")} 项检查通过`);
  } else if (failed.length > 0) {
    lines.push(`- 验证：存在失败项${failed.length > 1 ? `（${failed.length} 项）` : ""}`);
  } else {
    lines.push("- 验证：未观察到独立验证步骤");
  }
  return lines.join("\n");
}

function sum(acts: readonly WorkActivity[], kind: WorkActivity["kind"]): number {
  return acts
    .filter((a) => a.kind === kind)
    .reduce((n, a) => n + (a.batch ?? 1), 0);
}

/** True when the resolver had to invent nothing but still found
 *  no standalone conclusion (diagnostics code `missing_final_answer`
 *  — spec §10.3). Callers log this WITHOUT showing it to the user. */
export function isMissingFinalAnswer(projection: WorkTurnProjection): boolean {
  const existing = projection.terminal;
  if (existing?.kind === "final_answer" && !isTrivialFinalText(existing.text)) {
    return false;
  }
  return !(
    projection.narrations.slice().reverse().some(
      (n) => n.source !== "derived" && !isTrivialFinalText(n.text),
    ) ||
    projection.activities.some((a) =>
      (a.kind === "artifact" && a.summary.length > 0) ||
      (a.kind === "verification" && a.status === "completed"),
    )
  );
}
