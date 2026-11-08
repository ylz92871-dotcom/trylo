/**
 * WP27.3 priority ledger.
 *
 * "P0/P1 未清零" is not a state a reader can act on — it is a number. This
 * script turns it into one: for every P0/P1 capability, whether the authoritative
 * coverage matrix carries a current state and any evidence, who owns it, and
 * whether it is user-excluded (excluded rows are a decision, not a debt).
 *
 * It reads only the authoritative matrix and the mapping; it asserts no
 * maturity of its own and writes no state back. A row with evidence is not a
 * row that is done — this ledger counts what is written down, nothing more.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { coveragePathForReport, resolveCoveragePath } from "./coverage-source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mapping = JSON.parse(
  readFileSync(join(root, "docs", "01-分期施工总技术文档与架构", "CLI-PARITY-V1-分包", "能力分包映射.json"), "utf8"),
);
const coveragePath = resolveCoveragePath(root, mapping);
const coverage = JSON.parse(readFileSync(coveragePath, "utf8"));
const date = process.argv.slice(2).find((arg) => arg.startsWith("--date="))?.slice("--date=".length)
  ?? new Date().toISOString().slice(0, 10);
const evidenceDir = process.argv.slice(2).find((arg) => arg.startsWith("--out="))?.slice("--out=".length)
  ?? `${date}-WP27`;

const ownerById = new Map(mapping.rows.map((row) => [row.id, row.primaryWorkPackage]));
const EXCLUDED = new Set(mapping.productScopeDecision?.excludedCapabilityIds ?? []);
const PRIORITIES = ["P0", "P1"];

const rows = coverage.rows
  .filter((row) => PRIORITIES.includes(row.priority))
  .map((row) => {
    const hasState = (row.currentState ?? "").trim().length > 0;
    const evidence = row.evidence ?? [];

    return {
      id: row.id,
      name: row.name,
      priority: row.priority,
      owner: ownerById.get(row.id) ?? null,
      excludedByUser: EXCLUDED.has(row.id),
      sourceState: row.sourceState,
      delivery: row.delivery,
      hasCurrentState: hasState,
      evidenceCount: evidence.length,
      hasRemaining: (row.remaining ?? "").trim().length > 0,
      state: !hasState || evidence.length === 0 ? "unrecorded" : "recorded",
    };
  });

function tally(list) {
  return {
    total: list.length,
    excludedByUser: list.filter((row) => row.excludedByUser).length,
    recorded: list.filter((row) => row.state === "recorded").length,
    unrecorded: list.filter((row) => row.state === "unrecorded").length,
  };
}

const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, tally(rows.filter((row) => row.priority === p))]));
const byOwner = {};

for (const row of rows.filter((item) => item.state === "unrecorded" && !item.excludedByUser)) {
  byOwner[row.owner ?? "(unmapped)"] = (byOwner[row.owner ?? "(unmapped)"] ?? 0) + 1;
}

const overall = tally(rows);
const report = {
  date,
  package: "WP27.3-priority-ledger",
  source: coveragePathForReport(root, coveragePath),
  definition: {
    recorded: "主矩阵该行同时有 currentState 与至少一条 evidence",
    unrecorded: "缺 currentState 或 evidence 为空 —— 记为未闭合，不代表功能不存在",
    excludedByUser: "用户已取消整项，不作发布欠账",
  },
  overall,
  byPriority,
  unrecordedByOwner: byOwner,
  rows,
  verdict: overall.unrecorded === 0
    ? "P0/P1 全部已记名"
    : `P0/P1 未记名 ${overall.unrecorded} 项（其中排除 ${overall.excludedByUser} 项不作欠账），逐 ID 见 rows；成熟度归各包 owner 与主矩阵，WP27 不代签`,
};

writeFileSync(
  join(root, "docs", "02-分期工程产出", "P00-工程地基与质量门禁", "evidence", evidenceDir, "wp27-priority-ledger.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(`P0/P1 ledger: total=${overall.total} recorded=${overall.recorded} unrecorded=${overall.unrecorded} excluded=${overall.excludedByUser}`);

console.log(`P0: ${JSON.stringify(byPriority.P0)}`);

console.log(`P1: ${JSON.stringify(byPriority.P1)}`);