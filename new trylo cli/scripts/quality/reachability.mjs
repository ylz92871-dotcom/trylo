/**
 * Static import graph reachability calculator.
 * Starts from src/cmd/trylo/main.ts, follows all relative imports,
 * and classifies every production .ts file into the five-state taxonomy.
 *
 * Usage: node scripts/quality/reachability.mjs [--json]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = join(root, "src");
const importRe = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

const skipDirs = new Set(["node_modules", "dist", ".git", "open", "coverage", "_backup"]);

function walkTs(dir, acc = []) {
  if (!existsSync(dir)) return acc;

  let entries;

  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }

  for (const e of entries) {
    if (skipDirs.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkTs(full, acc);
    else if (e.isFile() && e.name.endsWith(".ts")) acc.push(full);
  }

  return acc;
}

function toPosix(abs) {
  return relative(srcRoot, abs).replaceAll("\\", "/");
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;

  const fromDir = dirname(fromFile);
  let candidate = resolve(fromDir, spec);

  // .js → .ts
  if (candidate.endsWith(".js")) {
    candidate = candidate.slice(0, -3) + ".ts";
  }

  // No extension → try .ts, /index.ts
  if (!extname(candidate)) {
    if (existsSync(candidate + ".ts")) return candidate + ".ts";
    if (existsSync(join(candidate, "index.ts"))) return join(candidate, "index.ts");
    return null;
  }

  return existsSync(candidate) ? candidate : null;
}

function extractImports(file) {
  const text = readFileSync(file, "utf8");
  const specs = [];
  for (const m of text.matchAll(importRe)) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

// BFS from entry points
function computeReachable(entryPoints) {
  const visited = new Set();
  const queue = [...entryPoints];

  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;

    if (!existsSync(file)) continue;

    visited.add(file);

    for (const spec of extractImports(file)) {
      const resolved = resolveImport(file, spec);
      if (resolved && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return visited;
}

// Classification rules
const TEST_SUPPORT_PATTERNS = [
  // Thin bridge used only by protected integration/check-learning/runtime.test.ts.
  // Remove this exact entry together with the bridge when that subsystem's
  // separate migration switches the test to the tool subsystem entrypoint.
  /^internal\/adapters\/tool-evolution\/process-verifier\.ts$/,
  /mock-oauth-server\.ts$/,
  /golden-trace\.ts$/,
  /golden-run-trace\.ts$/,
  /regression-harness\.ts$/,
  /\/fakes\.ts$/,
  /\/fixtures?\.ts$/,
  /\/testing\//,
  /\/testdata\//,
  /memory-fake\.ts$/,
  /memory-ledger-store\.ts$/,
  /registry-harness\.ts$/,
  /\/scenarios\.ts$/,
  /internal\/e2e\//,
  /internal\/journal\//,
  /env-backend\.ts$/,
];

const LIBRARY_REACHABLE_PREFIXES = [
  "internal/contract/",
  "internal/protocol/",
  "internal/ports/",
];

const LIBRARY_REACHABLE_FILES = new Set([
  "internal/domain/index.ts",
  "internal/loop/index.ts",
]);

const APPROVED_DEFERRED_PREFIXES = [
  "internal/learning/",
  "internal/integration/",
  "internal/adapters/learning-store/",
  "internal/adapters/permission-store/",
  "internal/adapters/verification-authority-store/",
  "internal/tooling/",
  "internal/adapters/tool-acquisition/",
  "internal/mcp/",
  "internal/adapters/mcp-",
  "internal/subagent/",
  "internal/evaluation/",
  "internal/knowledge/",
  "internal/surface/protocol/",
  "internal/surface/cli/tui/",
];

const APPROVED_DEFERRED_FILES = new Set([
  // P05 collaboration owner retains this exact V1/V2 host assembly entry for
  // historical migration compatibility (collaborationRuntimeFor / collaborationSessionFor).
  // No current src/scripts caller imports it; this is not a shared pure library.
  // Remove this entry when that legacy ABI is retired. A future main import is
  // still production_reachable because the actual BFS check precedes this set.
  "internal/surface/cli/collaboration-wiring.ts",
  "internal/loop/recover.ts",
  "internal/loop/reorder.ts",
  "internal/loop/replay.ts",
  "internal/domain/replay.ts",
  "internal/config/layers.ts",
  "internal/credentials/redact.ts",
]);

// Modules that were deferred but are now production-reachable per audit
const RECLASSIFIED_TO_PRODUCTION = [
  "internal/adapters/mcp-",
  "internal/subagent/",
  "internal/learning/agent/subsystems/method/",
];

function classify(relPath, reachableSet) {
  if (relPath.endsWith(".test.ts")) return "test";

  if (reachableSet.has(relPath)) {
    return "production_reachable";
  }

  for (const pat of TEST_SUPPORT_PATTERNS) {
    if (pat.test(relPath)) return "test_support";
  }

  if (LIBRARY_REACHABLE_FILES.has(relPath)) return "library_reachable";

  for (const prefix of LIBRARY_REACHABLE_PREFIXES) {
    if (relPath.startsWith(prefix)) return "library_reachable";
  }

  if (APPROVED_DEFERRED_FILES.has(relPath)) return "approved_deferred";

  for (const prefix of APPROVED_DEFERRED_PREFIXES) {
    if (relPath.startsWith(prefix)) return "approved_deferred";
  }

  return "unclassified";
}

// Main
const entryFile = join(srcRoot, "cmd", "trylo", "main.ts");
if (!existsSync(entryFile)) {
  console.error("FATAL: entry point not found:", entryFile);
  process.exit(1);
}

const reachable = computeReachable([entryFile]);
const reachableRel = new Set([...reachable].map(toPosix));

const allTs = walkTs(srcRoot);
const allRel = allTs.map(toPosix);
const prodFiles = allRel.filter((f) => !f.endsWith(".test.ts"));
const testFiles = allRel.filter((f) => f.endsWith(".test.ts"));

const taxonomy = {
  production_reachable: [],
  library_reachable: [],
  test_support: [],
  approved_deferred: [],
  unclassified: [],
};

for (const f of prodFiles) {
  const state = classify(f, reachableRel);
  if (state === "test") continue;

  if (taxonomy[state]) {
    taxonomy[state].push(f);
  } else {
    taxonomy.unclassified.push(f);
  }
}

// Also check: reclassified modules that are in reachable set
// Move from approved_deferred to production_reachable if actually reachable
const reclassified = [];

taxonomy.approved_deferred = taxonomy.approved_deferred.filter((f) => {
  if (reachableRel.has(f)) {
    reclassified.push(f);
    return false;
  }
  return true;
});

taxonomy.production_reachable.push(...reclassified);

const summary = {
  total_production_files: prodFiles.length,
  total_test_files: testFiles.length,
  reachable_from_main: reachableRel.size,
  taxonomy: {
    production_reachable: taxonomy.production_reachable.length,
    library_reachable: taxonomy.library_reachable.length,
    test_support: taxonomy.test_support.length,
    approved_deferred: taxonomy.approved_deferred.length,
    unclassified: taxonomy.unclassified.length,
  },
  reclassified_to_production: reclassified.length,
};

const wantJson = process.argv.includes("--json");

if (wantJson) {
  const output = { summary, taxonomy };
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "reachability.json"), JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("=== TRYLO CLI STATIC REACHABILITY ANALYSIS ===");
  console.log(`Entry: src/cmd/trylo/main.ts`);
  console.log(`Total production .ts files: ${prodFiles.length}`);
  console.log(`Total test .ts files: ${testFiles.length}`);
  console.log(`Reachable from main (BFS): ${reachableRel.size}`);
  console.log("");
  console.log("Five-state taxonomy:");
  console.log(`  production_reachable: ${taxonomy.production_reachable.length}`);
  console.log(`  library_reachable:    ${taxonomy.library_reachable.length}`);
  console.log(`  test_support:         ${taxonomy.test_support.length}`);
  console.log(`  approved_deferred:    ${taxonomy.approved_deferred.length}`);
  console.log(`  unclassified:         ${taxonomy.unclassified.length}`);

  if (reclassified.length > 0) {
    console.log(`\n  (reclassified from deferred → production: ${reclassified.length})`);
    for (const f of reclassified.slice(0, 20)) {
      console.log(`    ${f}`);
    }
    if (reclassified.length > 20) console.log(`    ... and ${reclassified.length - 20} more`);
  }

  if (taxonomy.unclassified.length > 0) {
    console.log(`\n  UNCLASSIFIED (needs triage):`);
    for (const f of taxonomy.unclassified.slice(0, 30)) {
      console.log(`    ${f}`);
    }
    if (taxonomy.unclassified.length > 30) console.log(`    ... and ${taxonomy.unclassified.length - 30} more`);
  }

  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "dist", "reachability.json"),
    JSON.stringify({ summary, taxonomy }, null, 2) + "\n",
  );
  console.log(`\nFull data written to dist/reachability.json`);
}
