/**
 * WP27.1 parity check — the machine half of "172 rows, one owner each".
 *
 * What this asserts: the capability mapping and the authoritative coverage
 * matrix agree on every id, no id has two owners, no prerequisite graph has a
 * cycle, and WP27's prerequisites are exactly the construction packages rather
 * than merely the same number of them.
 *
 * What it deliberately does not assert: maturity. A row being present is not a
 * row being done; maturity belongs to the coverage matrix and each package's own
 * evidence. Missing construction records stay warnings so parallel work is
 * visible without being counted as a defect.
 *
 * Two output copies are written on purpose: the evidence directory (the record
 * a human reads) and `dist/` (the copy tooling consumes). Both are stated here
 * rather than left as a surprise side effect.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCoveragePath } from "./coverage-source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mappingPath = join(root, "docs", "01-分期施工总技术文档与架构", "CLI-PARITY-V1-分包", "能力分包映射.json");

const failures = [];
const warnings = [];

function fail(detail) {
  failures.push(detail);
}

function warn(detail) {
  warnings.push(detail);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_SHAPE_HINT = "--date=YYYY-MM-DD";
/**
 * The evidence directory is this checker's own, and only its own: ending in
 * `-WP27` is what keeps a run from planting a report inside another package's
 * evidence directory, and the leading character requirement is what keeps `.`,
 * `..` and the empty string from resolving to `evidence/` itself.
 */
const EVIDENCE_DIR_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*-WP27$/;
const EVIDENCE_DIR_HINT = "--out=<name>-WP27";

function readFlag(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

/** A shape check is not a calendar check: `2026-13-45` has the right shape. */
function isRealIsoDay(value) {
  if (!ISO_DAY.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const date = readFlag("date") ?? new Date().toISOString().slice(0, 10);
if (!isRealIsoDay(date)) {
  console.error(`FAIL --date must be a real calendar day shaped like ${DATE_SHAPE_HINT}, got: ${date}`);
  process.exit(2);
}

const evidenceDirName = readFlag("out") ?? `${date}-WP27`;
if (!EVIDENCE_DIR_SHAPE.test(evidenceDirName)) {
  console.error(`FAIL --out must be this checker's own directory name shaped like ${EVIDENCE_DIR_HINT}, got: ${evidenceDirName}`);
  process.exit(2);
}

const outputDir = join(root, "docs", "02-分期工程产出", "P00-工程地基与质量门禁", "evidence", evidenceDirName);

const mapping = JSON.parse(readFileSync(mappingPath, "utf8"));

/**
 * The user-approved scope decision lives in the mapping, so it is read from
 * there rather than restated here. Two constants that merely agree today are
 * two constants that can silently disagree after the next scope decision.
 */
const scopeDecision = mapping.productScopeDecision ?? {};
const EXPECTED_TOTAL = scopeDecision.baselineRegistryItems;
const EXCLUDED_BY_USER = scopeDecision.excludedCapabilityIds ?? [];
if (!Number.isInteger(EXPECTED_TOTAL) || !Array.isArray(EXCLUDED_BY_USER)) {
  console.error("FAIL mapping.productScopeDecision is missing baselineRegistryItems/excludedCapabilityIds");
  process.exit(2);
}

/** The coverage matrix the mapping itself points at, so the two cannot drift. */
const coveragePath = resolveCoveragePath(root, mapping);
const coverage = JSON.parse(readFileSync(coveragePath, "utf8"));

const rows = mapping.rows ?? [];
if (rows.length !== EXPECTED_TOTAL) {
  fail(`mapping rows=${rows.length}, expected ${EXPECTED_TOTAL}`);
}

const missingPrimaryWorkPackage = [];
const seen = new Set();

for (const row of rows) {
  if (seen.has(row.id)) {
    fail(`duplicate capability id: ${row.id}`);
  }

  seen.add(row.id);

  if (typeof row.primaryWorkPackage !== "string" || row.primaryWorkPackage.trim().length === 0) {
    fail(`missing primaryWorkPackage: ${row.id}`);
    missingPrimaryWorkPackage.push(row.id);
  }
}

for (const excluded of EXCLUDED_BY_USER) {
  if (!seen.has(excluded)) {
    fail(`excluded id not in ledger: ${excluded}`);
  }
}

const coverageIds = new Set((coverage.rows ?? []).map((row) => row.id));
const missingInCoverage = [];

for (const row of rows) {
  if (!coverageIds.has(row.id)) {
    fail(`mapping id missing in capability-coverage.json: ${row.id}`);
    missingInCoverage.push(row.id);
  }
}

const packages = new Map(mapping.packages.map((pkg) => [pkg.id, pkg]));

/**
 * A prerequisite naming a package that does not exist looks exactly like a leaf
 * to a graph walk, so the walk would report "acyclic" about a dependency nobody
 * can satisfy. Every dangling edge is named before the walk runs.
 */
const danglingPrerequisites = [];

for (const pkg of mapping.packages) {
  for (const dep of pkg.prerequisites ?? []) {
    if (!packages.has(dep)) {
      danglingPrerequisites.push(`${pkg.id} -> ${dep}`);
    }
  }
}

if (danglingPrerequisites.length > 0) {
  fail(`prerequisite names an unknown package: ${danglingPrerequisites.join(", ")}`);
}

const visited = new Set();
const stack = new Set();
let cycle = null;

function dfs(id, trail) {
  if (stack.has(id)) {
    const start = trail.indexOf(id);
    cycle = start < 0 ? [id] : [...trail.slice(start), id];
    return true;
  }

  if (visited.has(id)) {
    return false;
  }

  visited.add(id);
  stack.add(id);
  const pkg = packages.get(id);

  for (const dep of pkg?.prerequisites ?? []) {
    if (dfs(dep, [...trail, id])) {
      return true;
    }
  }

  stack.delete(id);

  return false;
}

for (const pkg of mapping.packages) {
  if (dfs(pkg.id, [])) {
    break;
  }
}

if (cycle !== null) {
  fail(`prerequisite cycle: ${cycle.join(" -> ")}`);
}

/**
 * Count equality is not set equality: 26 prerequisites still hold after one real
 * package is swapped for a typo. WP27 must depend on every construction package
 * and on nothing else, so both directions are named.
 */
const constructionIds = [...new Set(
  mapping.packages.filter((pkg) => pkg.role === "construction").map((pkg) => pkg.id),
)];
const wp27Prerequisites = packages.get("WP27")?.prerequisites ?? [];
const wp27PrerequisiteSet = new Set(wp27Prerequisites);
const missingPrerequisites = constructionIds.filter((id) => !wp27PrerequisiteSet.has(id));
const extraPrerequisites = [...wp27PrerequisiteSet].filter((id) => !constructionIds.includes(id));

if (missingPrerequisites.length > 0) {
  fail(`WP27 does not depend on construction packages: ${missingPrerequisites.join(", ")}`);
}

if (extraPrerequisites.length > 0) {
  fail(`WP27 depends on packages that are not construction packages: ${extraPrerequisites.join(", ")}`);
}

/**
 * A construction record is a document about that package. Matching a bare
 * substring lets `WP260-something` satisfy `WP26`, and letting an ADR qualify
 * lets a scope decision stand in for the work it was written about.
 */
function hasConstructionRecord(file, id) {
  if (file.includes("ADR")) {
    return false;
  }
  const token = new RegExp(`(?<![0-9A-Za-z])${id}(?![0-9A-Za-z])`);
  return token.test(file) && (file.includes("施工记录") || file.includes("复核"));
}

const prodDir = join(root, "docs", "02-分期工程产出", "P00-工程地基与质量门禁");
const prodFiles = existsSync(prodDir) ? readdirSync(prodDir) : [];
const constructionRecordsMissing = [];

for (const id of constructionIds) {
  if (!prodFiles.some((file) => hasConstructionRecord(file, id))) {
    warn(`no P00 construction record yet: ${id} (parallel work in progress; WP27 keeps it unclosed)`);
    constructionRecordsMissing.push(id);
  }
}

const inScope = rows.filter((row) => !EXCLUDED_BY_USER.includes(row.id));

/**
 * Every field a reader would otherwise add by hand is computed here, so the
 * report on disk is always exactly what this run measured. A hand-augmented
 * report is indistinguishable from a measured one once written down, which is
 * how a stale number survives re-runs unchallenged.
 */
const report = {
  date,
  package: "WP27",
  status: failures.length === 0 ? "pass" : "fail",
  scopeDecision: `${scopeDecision.date ?? "unknown"}-ADR-WP26范围收缩与本地后台能力保留`,
  inputs: {
    mapping: relative(root, mappingPath).replaceAll("\\", "/"),
    coverage: relative(root, coveragePath).replaceAll("\\", "/"),
  },
  total: rows.length,
  excludedByUser: EXCLUDED_BY_USER,
  inScopeCount: inScope.length,
  expectedInScope: EXPECTED_TOTAL - EXCLUDED_BY_USER.length,
  prerequisiteCycle: cycle,
  danglingPrerequisites,
  wp27Prerequisites: wp27Prerequisites.length,
  wp27MissingPrerequisites: missingPrerequisites,
  wp27ExtraPrerequisites: extraPrerequisites,
  uniqueIds: seen.size,
  missingPrimaryWorkPackage,
  missingInCoverage,
  constructionPackages: constructionIds.length,
  constructionRecordsPresent: constructionIds.length - constructionRecordsMissing.length,
  constructionRecordsMissing,
  failures,
  warnings,
};

mkdirSync(outputDir, { recursive: true });

writeFileSync(join(outputDir, "wp27-parity-report.json"), `${JSON.stringify(report, null, 2)}\n`);

mkdirSync(join(root, "dist"), { recursive: true });

writeFileSync(join(root, "dist", "wp27-parity-report.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`WP27 parity: total=${report.total} inScope=${report.inScopeCount} excluded=${report.excludedByUser.length}`);

console.log(`evidence written to: ${evidenceDirName}/wp27-parity-report.json`);

for (const warning of warnings) {
  console.log(`WARN ${warning}`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
} else {
  console.log("PASS wp27-parity-check (structural integrity; construction gaps stay as warnings)");
}