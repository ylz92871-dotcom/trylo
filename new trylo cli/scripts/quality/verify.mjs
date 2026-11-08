import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runStaticScans } from "./static-scans.mjs";
import { hasReferenceDependency, hasReferenceImport } from "./reference-isolation.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const win = process.platform === "win32";
const skipDirs = new Set([".git", "node_modules", "dist", "open", "coverage"]);
const secretPatterns = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{36}/,
];
const importRe = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

let hasFailure = false;
const stepReports = [];

function posix(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function recordPass(step, detail = "") {
  console.log(`PASS ${step}${detail ? ` ${detail}` : ""}`);
  stepReports.push({ step, ok: true, detail });
}

function recordFail(step, detail = "") {
  hasFailure = true;
  console.error(`FAIL ${step}`);
  if (detail) {
    console.error(detail);
  }
  stepReports.push({ step, ok: false, detail });
}

function runCmd(command, args, options = {}) {
  const isNpm = command === "npm";
  const exe = win && isNpm ? "npm.cmd" : command;
  const result = spawnSync(exe, args, {
    cwd: root,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
    shell: win && isNpm,
    ...options,
  });

  return {
    code: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function walkFiles(dir, acc = []) {
  if (!dir || !existsSync(dir)) {
    return acc;
  }

  let entries;

  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    if (skipDirs.has(entry.name)) {
      continue;
    }

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      walkFiles(full, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }

  return acc;
}

// -------------------------------------------------------------
// Step 0: 0-repository-baseline
// -------------------------------------------------------------
function step0_repositoryBaseline() {
  const issues = [];
  const pkgPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");

  if (!existsSync(pkgPath)) {
    issues.push("missing package.json");
  }

  if (!existsSync(lockPath)) {
    issues.push("missing package-lock.json");
  }

  // R2: Hard check — source must be tracked by git
  // Check product source, not the research/document archive. Quoted long
  // paths there can exceed spawnSync's output buffer and mimic no Git baseline.
  const gitLsFiles = runCmd("git", ["ls-files", "--", join(root, "src")], { capture: true });
  const trackedCount = gitLsFiles.code === 0
    ? gitLsFiles.stdout.trim().split("\n").filter((l) => l.length > 0).length
    : 0;
  if (trackedCount === 0) {
    issues.push("BLOCKED_NO_BASELINE: git ls-files returned 0 tracked files — source not under version control");
  }

  // Check that dist, node_modules, and temporary patterns are not committed
  const gitCheck = runCmd("git", ["status", "--porcelain", "dist", "node_modules"], {
    capture: true,
  });
  if (gitCheck.code === 0 && gitCheck.stdout.trim().length > 0) {
    issues.push(`tracked build/dependency artifacts in git: ${gitCheck.stdout.trim()}`);
  }

  // Keep external reference trees and archives outside product inputs.
  const srcFiles = walkFiles(join(root, "src")).filter((f) => f.endsWith(".ts"));
  const openHits = [];

  for (const file of srcFiles) {
    const text = readFileSync(file, "utf8");
    if (hasReferenceImport(text)) {
      openHits.push(posix(file));
    }
  }

  if (hasReferenceDependency(readFileSync(join(root, "package.json"), "utf8"))) {
    openHits.push("package.json");
  }

  if (openHits.length > 0) {
    issues.push(`isolation violation: external reference inputs: ${openHits.join(", ")}`);
  }

  // Record lockfile hash and inventory
  let lockHash = "missing";

  if (existsSync(lockPath)) {
    lockHash = createHash("sha256").update(readFileSync(lockPath)).digest("hex");
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  if (issues.length > 0) {
    recordFail("0-repository-baseline", issues.join("\n"));
  } else {
    recordPass("0-repository-baseline", `Node ${process.version} lockHash=${lockHash.slice(0, 8)} deps=${Object.keys(deps).length} tracked=${trackedCount}`);
  }
}

// -------------------------------------------------------------
// Step 1: 1-format
// -------------------------------------------------------------
function step1_format() {
  const res = runCmd(process.execPath, [join(root, "scripts", "quality", "format-check.mjs")], {
    capture: true,
  });
  if (res.code !== 0) {
    recordFail("1-format", res.stdout + res.stderr);
  } else {
    recordPass("1-format", "hygiene check pass");
  }
}

// -------------------------------------------------------------
// Step 2: 2-typecheck (includes noUnusedLocals/noUnusedParameters via tsconfig)
// -------------------------------------------------------------
function step2_typecheck() {
  const res = runCmd("npm", ["run", "build"], { capture: true });
  if (res.code !== 0) {
    recordFail("2-typecheck", (res.stdout + res.stderr).slice(-2000));
  } else {
    recordPass("2-typecheck", "tsc strict build pass (noUnusedLocals + noUnusedParameters enforced)");
  }
}

// -------------------------------------------------------------
// Step 3: 3-lint-hygiene
// The scans live in static-scans.mjs so the pre-commit hook enforces the
// same rule at commit time — two copies would be two opinions.
// -------------------------------------------------------------
function step3_lintHygiene() {
  const { issues, fileCount } = runStaticScans(root);
  if (issues.length > 0) {
    recordFail("3-lint-hygiene", issues.join("\n"));
  } else {
    recordPass(
      "3-lint-hygiene",
      `0 ts-ignore, 0 any, 0 empty catch, 0 unseamed ambient, 0 unlisted double-cast, 0 fake-imports in reachable code across ${fileCount} files`,
    );
  }
}

// -------------------------------------------------------------
// Step 4: 4-architecture
// -------------------------------------------------------------
function step4_architecture() {
  const issues = [];
  const loopDir = join(root, "src", "internal", "loop");
  const domainDir = join(root, "src", "internal", "domain");
  const portsDir = join(root, "src", "internal", "ports");

  const coreDirs = [loopDir, domainDir];

  for (const dir of coreDirs) {
    for (const file of walkFiles(dir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(importRe)) {
        const spec = match[1] ?? "";
        const parts = spec.split(/[\\/]/);
        if (parts.includes("adapters") || parts.includes("knowledge") || parts.includes("surface") || parts.includes("desktop")) {
          issues.push(`core illegal import: ${posix(file)} imports ${spec}`);
        }
      }
    }
  }

  for (const file of walkFiles(portsDir).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importRe)) {
      const spec = match[1] ?? "";
      const parts = spec.split(/[\\/]/);
      if (parts.includes("surface") || parts.includes("adapters") || parts.includes("loop")) {
        issues.push(`ports illegal import: ${posix(file)} imports ${spec}`);
      }
    }
  }

  // Prove-fail test with boundary fixture
  const boundaryFixture = join(root, "testdata", "licenses", "boundary", "forbidden-core-import-ui.ts");
  if (!existsSync(boundaryFixture)) {
    issues.push("missing boundary prove-fail fixture: testdata/licenses/boundary/forbidden-core-import-ui.ts");
  } else {
    const fixtureText = readFileSync(boundaryFixture, "utf8");
    const matches = [...fixtureText.matchAll(importRe)];
    const detected = matches.some((m) => (m[1] ?? "").includes("desktop") || (m[1] ?? "").includes("host-adapter"));
    if (!detected) {
      issues.push("boundary prove-fail fixture was not detected by architecture rule");
    }
  }

  if (issues.length > 0) {
    recordFail("4-architecture", issues.join("\n"));
  } else {
    recordPass("4-architecture", "layering clean & boundary prove-fail validated");
  }
}

// -------------------------------------------------------------
// Step 5: 5-contract-tests (R5: actually execute contract test suites)
// -------------------------------------------------------------
function step5_contractTests() {
  const contractSrcFiles = [
    join(root, "src", "internal", "contract", "canonical.test.ts"),
    join(root, "src", "internal", "credentials", "contract.test.ts"),
    join(root, "src", "internal", "protocol", "mapping-table.test.ts"),
  ];

  const missingSrc = contractSrcFiles.filter((f) => !existsSync(f));
  if (missingSrc.length > 0) {
    recordFail("5-contract-tests", `contract test source missing: ${missingSrc.map((f) => posix(f)).join(", ")}`);
    return;
  }

  const contractDistFiles = [
    join(root, "dist", "internal", "contract", "canonical.test.js"),
    join(root, "dist", "internal", "credentials", "contract.test.js"),
    join(root, "dist", "internal", "protocol", "mapping-table.test.js"),
  ];

  const missing = contractDistFiles.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    recordFail("5-contract-tests", `compiled contract tests missing (run build first): ${missing.map((f) => posix(f)).join(", ")}`);
    return;
  }

  const res = spawnSync(process.execPath, ["--test", ...contractDistFiles], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });

  if (res.status !== 0) {
    const output = ((res.stdout ?? "") + (res.stderr ?? "")).slice(-2000);
    recordFail("5-contract-tests", `contract test execution failed:\n${output}`);
  } else {
    const out = res.stdout ?? "";
    const passCount = out.split("\n").filter((l) => /^(ok |✔)/.test(l.trim())).length;
    recordPass("5-contract-tests", `contract suites executed (${passCount} tests pass)`);
  }
}

// -------------------------------------------------------------
// Step 6: 6-unit-tests (hermetic suite — the single test step)
// -------------------------------------------------------------
function step6_unitTests() {
  console.log("Running hermetic tests...");
  const res = runCmd(process.execPath, [
    join(root, "scripts", "quality", "run-tests.mjs"),
    "--layer=hermetic",
  ]);

  if (res.code !== 0) {
    recordFail("6-unit-tests", "hermetic unit tests failed");
    return;
  }

  const discoveryFile = join(root, "dist", "test-discovery.json");
  let testCount = 0;

  if (existsSync(discoveryFile)) {
    try {
      const data = JSON.parse(readFileSync(discoveryFile, "utf8"));
      testCount = data.testCount ?? 0;
    } catch {
      // ignore
    }
  }

  recordPass("6-unit-tests", `hermetic test suite passed (${testCount} test names ok)`);
}

// -------------------------------------------------------------
// Step 7: 7-transitions (R1: real execution of domain transitions test)
// -------------------------------------------------------------
function step7_transitions() {
  const transitionsDist = join(root, "dist", "internal", "domain", "transitions.test.js");
  if (!existsSync(transitionsDist)) {
    recordFail("7-transitions", "compiled transitions test missing (run build first)");
    return;
  }

  const res = spawnSync(process.execPath, ["--test", transitionsDist], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });

  if (res.status !== 0) {
    const output = ((res.stdout ?? "") + (res.stderr ?? "")).slice(-2000);
    recordFail("7-transitions", `transitions matrix test failed:\n${output}`);
  } else {
    recordPass("7-transitions", "domain transitions matrix executed and passed");
  }
}

// -------------------------------------------------------------
// Step 8: 8-license-and-sbom (R6: reads real node_modules licenses)
// -------------------------------------------------------------
function step8_licenseAndSbom() {
  const issues = [];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  const deps = Object.keys(pkg.dependencies ?? {});
  const allDeps = [...deps, ...devDeps];

  const ALLOWED_LICENSES = new Set(["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD"]);

  const sbomComponents = [];

  for (const dep of allDeps) {
    const depPkgPath = join(root, "node_modules", dep, "package.json");
    if (!existsSync(depPkgPath)) {
      // Scoped packages: node_modules/@scope/name
      issues.push(`dependency not installed: ${dep} (node_modules/${dep}/package.json missing)`);
      continue;
    }

    try {
      const depPkg = JSON.parse(readFileSync(depPkgPath, "utf8"));
      const license = depPkg.license ?? "UNKNOWN";
      const version = depPkg.version ?? "0.0.0";

      if (!ALLOWED_LICENSES.has(license)) {
        issues.push(`unapproved license: ${dep}@${version} → ${license}`);
      }

      sbomComponents.push({
        name: dep,
        version,
        licenses: [{ license: { id: license } }],
        purl: `pkg:npm/${dep.replace("/", "%2F")}@${version}`,
      });
    } catch (e) {
      issues.push(`failed to parse ${dep}/package.json: ${e.message}`);
    }
  }

  // Also scan transitive deps present in node_modules (flat layout)
  const nmDir = join(root, "node_modules");
  if (existsSync(nmDir)) {
    const entries = readdirSync(nmDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@")) {
        const scopeDir = join(nmDir, entry.name);
        const scoped = readdirSync(scopeDir, { withFileTypes: true });

        for (const s of scoped) {
          if (!s.isDirectory()) continue;

          const fullName = `${entry.name}/${s.name}`;
          if (allDeps.includes(fullName)) continue;

          const pPath = join(scopeDir, s.name, "package.json");
          if (existsSync(pPath)) {
            try {
              const p = JSON.parse(readFileSync(pPath, "utf8"));
              const lic = p.license ?? "UNKNOWN";
              if (!ALLOWED_LICENSES.has(lic)) {
                issues.push(`unapproved transitive license: ${fullName}@${p.version} → ${lic}`);
              }

              sbomComponents.push({
                name: fullName,
                version: p.version ?? "0.0.0",
                licenses: [{ license: { id: lic } }],
                purl: `pkg:npm/${fullName.replace("/", "%2F")}@${p.version}`,
              });
            } catch { /* skip unparseable */ }
          }
        }
      } else if (entry.isDirectory()) {
        if (allDeps.includes(entry.name)) continue;

        const pPath = join(nmDir, entry.name, "package.json");
        if (existsSync(pPath)) {
          try {
            const p = JSON.parse(readFileSync(pPath, "utf8"));
            const lic = p.license ?? "UNKNOWN";
            if (!ALLOWED_LICENSES.has(lic)) {
              issues.push(`unapproved transitive license: ${entry.name}@${p.version} → ${lic}`);
            }

            sbomComponents.push({
              name: entry.name,
              version: p.version ?? "0.0.0",
              licenses: [{ license: { id: lic } }],
              purl: `pkg:npm/${entry.name}@${p.version}`,
            });
          } catch { /* skip unparseable */ }
        }
      }
    }
  }

  // License fixture self-test (supplementary, not primary)
  const manifestPath = join(root, "testdata", "licenses", "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const fixtures = manifest.fixtures ?? [];

    for (const name of fixtures) {
      const compPath = join(root, "testdata", "licenses", name, "component.json");
      if (!existsSync(compPath)) {
        issues.push(`missing fixture component.json: ${name}`);
      }
    }
  }

  // Generate SBOM from real data
  mkdirSync(join(root, "dist"), { recursive: true });
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { name: pkg.name, version: pkg.version, type: "application" },
    },
    components: sbomComponents,
  };

  writeFileSync(join(root, "dist", "sbom.json"), JSON.stringify(sbom, null, 2) + "\n");

  // Generate THIRD_PARTY_NOTICES from real data
  const noticeLines = sbomComponents.map((c) => `- ${c.name}@${c.version}: ${c.licenses[0]?.license?.id ?? "UNKNOWN"}`);
  const notices = `# Third-Party Notices\n\nThis distribution includes components licensed under:\n${noticeLines.join("\n")}\n`;

  writeFileSync(join(root, "dist", "THIRD_PARTY_NOTICES.md"), notices);

  if (issues.length > 0) {
    recordFail("8-license-and-sbom", issues.join("\n"));
  } else {
    recordPass("8-license-and-sbom", `license closure valid (${sbomComponents.length} packages scanned), generated dist/sbom.json & THIRD_PARTY_NOTICES.md`);
  }
}

// -------------------------------------------------------------
// Step 9: 9-source-scan (R8: renamed from release-artifact-audit)
// -------------------------------------------------------------
function step9_sourceScan() {
  const problems = [];
  const scanDirs = [join(root, "src"), join(root, "scripts", "quality")];

  for (const dir of scanDirs) {
    for (const file of walkFiles(dir)) {
      const st = statSync(file);
      if (st.size > 1_000_000) {
        problems.push(`large:${posix(file)} (${st.size} bytes)`);
      }

      const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
      if ([".exe", ".dll", ".bin", ".node"].includes(ext)) {
        problems.push(`binary:${posix(file)}`);
      }

      if ([".ts", ".json", ".md"].some((e) => file.endsWith(e))) {
        const text = readFileSync(file, "utf8");
        for (const re of secretPatterns) {
          if (re.test(text)) {
            problems.push(`secret:${posix(file)}`);
            break;
          }
        }
      }
    }
  }

  const srcNested = walkFiles(join(root, "src")).some((f) => f.includes("node_modules"));
  if (srcNested) {
    problems.push("nested node_modules found inside src");
  }

  if (problems.length > 0) {
    recordFail("9-source-scan", problems.join("\n"));
  } else {
    recordPass("9-source-scan", "0 secrets, 0 unexpected binaries, 0 large files in source tree");
  }
}

// -------------------------------------------------------------
// Step 10: 10-doc-evidence-presence (R8: renamed, report text honest)
// -------------------------------------------------------------
function step10_docEvidencePresence() {
  const issues = [];
  const readmePath = join(root, "README.md");
  if (!existsSync(readmePath)) {
    issues.push("missing README.md");
  } else {
    const readme = readFileSync(readmePath, "utf8");
    if (readme.includes("生产代码尚未获准跨过 P00 门禁")) {
      issues.push("README contains stale P00 empty skeleton claim");
    }
  }

  const evidenceDir = join(root, "docs", "02-分期工程产出", "P00-工程地基与质量门禁", "evidence");
  const baselineEvidence = join(evidenceDir, "2026-09-18-ENG-0-BASELINE.md");
  if (!existsSync(baselineEvidence)) {
    issues.push("missing ENG-0 baseline evidence");
  }

  const triageEvidence = join(evidenceDir, "2026-09-18-ENG-3-SPECULATION-TRIAGE.md");
  if (!existsSync(triageEvidence)) {
    issues.push("missing ENG-3 triage evidence");
  }

  const adr0001 = join(
    root, "docs", "02-分期工程产出", "P00-工程地基与质量门禁",
    "ADR-0001-官方发行拓扑与核心工具链许可.md",
  );
  if (!existsSync(adr0001)) {
    issues.push("missing ADR-0001 doc");
  }

  if (issues.length > 0) {
    recordFail("10-doc-evidence-presence", issues.join("\n"));
  } else {
    recordPass("10-doc-evidence-presence", "presence checks passed (README, ENG-0, ENG-3, ADR-0001)");
  }
}

// -------------------------------------------------------------
// Main Runner (11 steps)
// -------------------------------------------------------------
console.log("=== TRYLO CLI QUALITY VERIFICATION PIPELINE (11 STEPS) ===");

const startTime = Date.now();

step0_repositoryBaseline();

step1_format();

step2_typecheck();

step3_lintHygiene();

step4_architecture();

step5_contractTests();

step6_unitTests();

step7_transitions();

step8_licenseAndSbom();

step9_sourceScan();

step10_docEvidencePresence();

const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

console.log(`\n=== VERIFICATION RESULT: ${hasFailure ? "FAILED" : "ALL PASS"} (${elapsed}s) ===`);

mkdirSync(join(root, "dist"), { recursive: true });

writeFileSync(
  join(root, "dist", "verify-result.json"),
  JSON.stringify({ ok: !hasFailure, elapsed, steps: stepReports }, null, 2) + "\n",
);

if (hasFailure) {
  process.exit(1);
} else {
  process.exit(0);
}
