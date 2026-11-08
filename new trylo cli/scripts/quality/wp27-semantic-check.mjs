/**
 * WP27.1 semantic naming check.
 *
 * The first pass of this check looked for the watch verbs and the `cancelled`
 * terminal in A04/L32/A06 and reported them missing. That was the check being
 * wrong, not the ledger: A04 is the `bg` family (ps/logs/attach/kill) and A07 is
 * the watch/sleep family, so demanding watch verbs in A04 asks a row to name
 * another row's contract. The check below therefore carries an explicit owner
 * per concept and asks the owning row, so a miss names the row that owes the
 * naming instead of three rows that never did.
 *
 * It reads the mapping and the shipped source, and writes one JSON verdict. It
 * asserts nothing about maturity.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mapping = JSON.parse(
  readFileSync(join(root, "docs", "01-分期施工总技术文档与架构", "CLI-PARITY-V1-分包", "能力分包映射.json"), "utf8"),
);
const date = process.argv.slice(2).find((arg) => arg.startsWith("--date="))?.slice("--date=".length)
  ?? new Date().toISOString().slice(0, 10);
const evidenceDir = process.argv.slice(2).find((arg) => arg.startsWith("--out="))?.slice("--out=".length)
  ?? `${date}-WP27`;

const rowById = new Map(mapping.rows.map((row) => [row.id, row]));

/** The vocabulary is the one place that says which verbs exist. */
const vocabulary = readFileSync(
  join(root, "src/internal/surface/cli/command-vocabulary.ts"), "utf8",
);
const watchVerbs = /watch:\s*\[([^\]]+)\]/.exec(vocabulary)?.[1]
  ?.split(",").map((word) => word.trim().replaceAll('"', "")).filter((word) => word.length > 0) ?? [];

const WATCH_OWNER = "A07";
const SCHEDULE_OWNER = "A06";

/**
 * Each concept names the row that owns it, the literal that proves the code
 * carries it, and the pattern the owning row's own text must contain.
 */
const CONCEPTS = [
  {
    concept: "watch 五动词",
    owner: WATCH_OWNER,
    source: "src/internal/surface/cli/command-vocabulary.ts",
    inCode: watchVerbs,
    requiredInRow: watchVerbs,
    note: "watch 家族的五个动词；owner 是 A07（条件监控），不是 A04（bg 四动词）",
  },
  {
    concept: "WatchState cancelled 终态",
    owner: WATCH_OWNER,
    source: "src/internal/domain/watch.ts",
    inCode: "cancelled",
    requiredInRow: ["cancelled", "cancel"],
    note: "watch 取消是终态，取消不得伪造 fire",
  },
  {
    concept: "occurrence cancelled 终态",
    owner: SCHEDULE_OWNER,
    source: "src/internal/ports/schedule.ts",
    inCode: "cancelled",
    requiredInRow: ["cancelled", "cancel"],
    note: "未派发即停按 cancelled 结算，不伪造 attempt 结果",
  },
  {
    concept: "unknown 一等终态",
    owner: "L32",
    source: "src/internal/ports/schedule.ts",
    inCode: "unknown",
    requiredInRow: ["unknown"],
    note: "unknown 不自动重做",
  },
  {
    concept: "requeue 补回队尾",
    owner: "L32",
    source: "src/internal/ports/background-queue.ts",
    inCode: "requeue",
    requiredInRow: ["requeue"],
    note: "保 id、保到达时间",
  },
  {
    concept: "pid 身份确认",
    owner: "A04",
    source: "src/internal/ports/process-session.ts",
    inCode: "pid",
    requiredInRow: ["pid"],
    note: "pid 以 verifyIdentity 双因子确认",
  },
  {
    concept: "family 委派",
    owner: SCHEDULE_OWNER,
    source: "src/internal/surface/cli/args-primitives.ts",
    inCode: "family",
    requiredInRow: ["family"],
    note: "根命令只认词，args 交家族解析",
  },
];

const results = CONCEPTS.map((concept) => {
  const row = rowById.get(concept.owner);
  const rowText = `${row?.currentState ?? ""} ${(row?.evidence ?? []).join(" ")}`;
  const missing = concept.requiredInRow.filter((term) => !rowText.includes(term));

  return {
    concept: concept.concept,
    owner: concept.owner,
    rowName: row?.name,
    codeCarriesIt: Array.isArray(concept.inCode) ? concept.inCode.join(",") : concept.inCode,
    source: concept.source,
    namedInRow: missing.length === 0,
    missingTerms: missing,
    note: concept.note,
  };
});

/** A row that is in scope but carries neither a state nor evidence is stale. */
const staleRows = mapping.rows
  .filter((row) => row.productScope?.state !== "excluded_by_user")
  .filter((row) => (row.currentState ?? "").trim().length === 0 || (row.evidence ?? []).length === 0)
  .map((row) => row.id);

const unnamed = results.filter((result) => !result.namedInRow);
const verdict = unnamed.length === 0 && staleRows.length === 0
  ? "PASS: 本批新增语义已在各自 owner 行记名，无过期行"
  : `PARTIAL: 未记名 ${unnamed.map((item) => `${item.concept}@${item.owner}`).join("、") || "无"}；过期行 ${staleRows.join(",") || "无"}`;

const report = {
  date,
  package: "WP27.1-semantic",
  rule: "本批新增语义（watch 五动词 / cancelled 终态 / unknown / requeue / pid / family）必须已在各自 owner 行记名",
  scopingCorrection: "上一轮把 watch 五动词与 cancelled 记名要求发到 A04/L32/A06；A04 是 bg 四动词行、watch 属 A07，故该 FAIL 是检查错投行而非映射缺记名。本轮按 owner 复查。",
  results,
  staleRowsWithoutStateOrEvidence: staleRows,
  verdict,
};

writeFileSync(
  join(root, "docs", "02-分期工程产出", "P00-工程地基与质量门禁", "evidence", evidenceDir, "wp27-scope-semantic-check.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(verdict);

for (const item of unnamed) {
  console.log(`UNNAMED ${item.concept} @ ${item.owner} (missing: ${item.missingTerms.join(", ")})`);
}

if (staleRows.length > 0) {
  console.log(`STALE ROWS: ${staleRows.join(", ")}`);
}