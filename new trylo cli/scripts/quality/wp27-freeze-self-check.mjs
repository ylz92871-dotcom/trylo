/**
 * WP27.3 freeze self-check.
 *
 * WP27 is the package that judges other packages' freeze candidates, so the
 * first candidate it judges is its own. This script builds that candidate from
 * the files actually on disk and hands it to the shipped `validateFreezeCandidate`,
 * then writes down whatever that module concludes. It never states a verdict of
 * its own.
 *
 * The reviewed revision is deliberately recorded as the pre-fix hash this
 * session's independent review actually read. Recording the post-fix hash would
 * make the module answer `freezable` and mean nothing by it: that review has not
 * been repeated against the code which would be frozen.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = join(root, "dist", "internal", "integration", "wp27", "freeze-record.js");
if (!existsSync(modulePath)) {
  console.error("FAIL build first: this verdict is computed by the shipped module, not restated by hand");
  process.exit(2);
}

const { validateFreezeCandidate } = await import(pathToFileURL(modulePath).href);

const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const date = flag("date") ?? new Date().toISOString().slice(0, 10);
const evidenceDir = flag("out") ?? `${date}-WP27`;
/** The revision the independent reviewer read, before this session's fixes. */
const reviewedHash = flag("reviewed-hash") ?? "";

const SOURCES = [
  "src/internal/integration/wp27/scope-ledger.ts",
  "src/internal/integration/wp27/cross-loop.ts",
  "src/internal/integration/wp27/freeze-record.ts",
  "scripts/quality/wp27-parity-check.mjs",
  "scripts/quality/coverage-source.mjs",
  "scripts/quality/wp27-semantic-check.mjs",
  "scripts/quality/wp27-priority-ledger.mjs",
  "scripts/quality/wp27-cross-loop-realistic.mjs",
];

const digestOf = (file) => {
  const full = join(root, file);
  return existsSync(full) ? createHash("sha256").update(readFileSync(full)).digest("hex") : null;
};

const perFile = Object.fromEntries(SOURCES.map((file) => [file, digestOf(file)]));
/** One hash over the whole deliverable, so "which revision" has one answer. */
const sourceHash = createHash("sha256")
  .update(SOURCES.map((file) => `${file}:${perFile[file] ?? "absent"}`).join("\n"))
  .digest("hex");

const mapping = JSON.parse(
  readFileSync(join(root, "docs", "01-分期施工总技术文档与架构", "CLI-PARITY-V1-分包", "能力分包映射.json"), "utf8"),
);
const scope = mapping.rows.map((row) => ({
  id: row.id,
  scope: (mapping.productScopeDecision?.excludedCapabilityIds ?? []).includes(row.id)
    ? "excluded_by_user"
    : "in_scope",
  primaryWorkPackage: row.primaryWorkPackage,
}));

const evidenceLink = `docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/${evidenceDir}/`;

const self = validateFreezeCandidate(
  {
    packageId: "WP27",
    sourceHash,
    reviewedHash,
    artifactPath: "evidence/" + evidenceDir + "/",
    evidenceLink,
    implementer: "Muse Spark (session agent, implementer)",
    reviewer: "independent reviewer agent (separate context, non-implementer)",
    maturityClaim: "locally_verified",
  },
  scope,
);

/**
 * The rule demo for an all-excluded package. No real package qualifies: both
 * excluded ids (C80/A05) sit on WP26, which also owns eight in-scope rows, so
 * testing WP26 here would prove nothing. The scope below therefore attributes
 * only the excluded ids to a stand-in package, which is what the rule is about.
 */
const excludedIds = mapping.productScopeDecision?.excludedCapabilityIds ?? [];
const excludedCarryingPass = validateFreezeCandidate(
  {
    packageId: "DEMO-ALL-EXCLUDED",
    sourceHash,
    reviewedHash: sourceHash,
    artifactPath: "evidence/",
    evidenceLink,
    implementer: "someone",
    reviewer: "someone-else",
    maturityClaim: "release_accepted",
  },
  excludedIds.map((id) => ({ id, scope: "excluded_by_user", primaryWorkPackage: "DEMO-ALL-EXCLUDED" })),
);

const report = {
  date,
  package: "WP27.3",
  module: "src/internal/integration/wp27/freeze-record.ts validateFreezeCandidate",
  provenance: "候选对象由磁盘真实文件哈希构造，终局由本包已编译模块计算，脚本不自述结论",
  sourceHash,
  reviewedHash: reviewedHash === "" ? null : reviewedHash,
  perFileSha256: perFile,
  self,
  excludedCarryingPass,
  note: "两条各自独立的拒绝理由。其一，本包是验收包，mapping 里 capabilityIds 为空，"
    + "不拥有任何能力，因此不存在可冻结的主责（no_owned_capability）——"
    + "这不是缺陷，是把“验收包”与“能力主责包”分开的结果。"
    + "其二，独立复核发生在本轮修复之前且未与当前哈希绑定，"
    + "复验并以同一哈希记名之前不得判 freezable，也不得判 26 包冻结。",
};

writeFileSync(
  join(root, "docs", "02-分期工程产出", "P00-工程地基与质量门禁", "evidence", evidenceDir, "wp27-freeze-self-check.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(`WP27 self freeze: ${self.kind}${self.kind === "not_freezable" ? ` (${self.failures.map((f) => f.code).join(", ")})` : ""}`);

console.log(`excluded-carrying-pass: ${excludedCarryingPass.kind}`);

console.log(`sourceHash=${sourceHash.slice(0, 16)} reviewedHash=${reviewedHash === "" ? "(none)" : reviewedHash.slice(0, 16)}`);