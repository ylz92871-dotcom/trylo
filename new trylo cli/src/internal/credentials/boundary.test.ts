import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * Architecture and source-size gate (WP §3, §5 adversarial #12, §5 test standard).
 *
 * Two things a reader on another team needs proven:
 *
 *  1. **Dependency direction.** The credentials package imports only the protocol
 *     contracts, its own port, its own modules, and `node:` builtins. It must not
 *     reach `surface/cli`, `cmd`, `loop`, `adapters/provider`, `compaction`,
 *     `adapters/session-store`, `settings`, `config`, `mcp`, or `learning` — the
 *     packages the parallel vulnerability work owns.
 *  2. **No production file over 400 lines.** Checked here so the gate fails in a
 *     test the same way it would in review, and so a future edit that grows a
 *     module past the limit is visible.
 *
 * The scanner is made discriminating on purpose: a `0 hits` assertion alone
 * cannot tell a clean tree from a wrong directory or a broken regex, so the same
 * detector runs against two fixtures under `testdata/credentials/architecture/`.
 */

const repoRoot = process.cwd();
const credentialsDir = join(repoRoot, "src", "internal", "credentials");
const adaptersDir = join(repoRoot, "src", "internal", "adapters", "credentials");
const portFile = join(repoRoot, "src", "internal", "ports", "credentials.ts");
const fixturesDir = join(repoRoot, "testdata", "credentials", "architecture");

const MAX_PRODUCTION_LINES = 400;

/** Directory segments forbidden in an import specifier (WP §3 forbidden list). */
const FORBIDDEN_SEGMENTS = [
  "surface",
  "cli",
  "cmd",
  "loop",
  "provider",
  "compaction",
  "session-store",
  "settings",
  "config",
  "mcp",
  "learning",
];

const SPECIFIER_PATTERN = /(?:from\s+|import\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function importedSpecifiers(source: string): ReadonlyArray<string> {
  const specifiers: string[] = [];

  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

function segmentHits(specifier: string): ReadonlyArray<string> {
  const segments = specifier.replaceAll("\\", "/").split("/");
  return FORBIDDEN_SEGMENTS.filter((segment) => segments.includes(segment));
}

function isBarePackage(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("node:");
}

function violationsIn(source: string): ReadonlyArray<string> {
  const violations: string[] = [];

  for (const specifier of importedSpecifiers(source)) {
    for (const segment of segmentHits(specifier)) {
      violations.push(`forbidden-layer:${segment} via ${specifier}`);
    }
    if (isBarePackage(specifier)) {
      violations.push(`bare-package-import via ${specifier}`);
    }
  }

  return violations;
}

function tsFilesIn(dir: string, options: { readonly productionOnly?: boolean } = {}): ReadonlyArray<string> {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...tsFilesIn(full, options));
      continue;
    }

    if (!full.endsWith(".ts")) {
      continue;
    }

    if (options.productionOnly === true && full.endsWith(".test.ts")) {
      continue;
    }

    files.push(full);
  }

  return files;
}

function productionFiles(): ReadonlyArray<string> {
  return [...tsFilesIn(credentialsDir, { productionOnly: true }), ...tsFilesIn(adaptersDir, { productionOnly: true }), portFile];
}

test("no production file imports a forbidden layer or a bare package", () => {
  const files = productionFiles();

  assert.equal(files.length >= 12, true, `too few files scanned (${files.length})`);
  let specifierCount = 0;
  const violations: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    specifierCount += importedSpecifiers(source).length;
    for (const violation of violationsIn(source)) {
      violations.push(`${relative(repoRoot, file).replaceAll("\\", "/")} ${violation}`);
    }
  }

  assert.equal(specifierCount >= 20, true, "too few specifiers scanned; detector may be broken");
  assert.deepEqual(violations, []);
});

test("no credits file imports the settings or config package", () => {
  for (const file of productionFiles()) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importedSpecifiers(source)) {
      const normalized = specifier.replaceAll("\\", "/");
      assert.equal(
        normalized.includes("settings/") || normalized.includes("config/"),
        false,
        `${relative(repoRoot, file)} imports ${specifier}`,
      );
    }
  }
});

test("every production file is at most 400 lines (adversarial #12 / WP §0)", () => {
  const offenders: string[] = [];

  for (const file of productionFiles()) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).length;
    if (lines > MAX_PRODUCTION_LINES) {
      offenders.push(`${relative(repoRoot, file)} (${lines} lines)`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("the compose factory function is at most 60 lines (adversarial #12)", () => {
  const source = readFileSync(join(adaptersDir, "compose.ts"), "utf8");
  const start = source.indexOf("export function createCredentialPort");

  assert.equal(start >= 0, true, "factory not found");
  const body = source.slice(start);
  const end = body.indexOf("\n}\n");
  const lines = body.slice(0, end === -1 ? body.length : end).split(/\r?\n/).length;

  assert.equal(lines <= 60, true, `createCredentialPort is ${lines} lines`);
});

test("the detector is discriminating: the forbidden fixture lights up on every layer", () => {
  const source = readFileSync(join(fixturesDir, "forbidden-import-credentials.ts"), "utf8");
  const violations = violationsIn(source);

  for (const segment of FORBIDDEN_SEGMENTS) {
    assert.equal(
      violations.some((item) => item.startsWith(`forbidden-layer:${segment}`)),
      true,
      `fixture must trigger ${segment}`,
    );
  }
});

test("the detector does not false-positive: the allowed fixture is clean", () => {
  const source = readFileSync(join(fixturesDir, "allowed-import-credentials.ts"), "utf8");
  assert.deepEqual(violationsIn(source), []);
});

test("the fixture directory exists and holds exactly the two scanner fixtures", () => {
  const names = readdirSync(fixturesDir).sort();
  assert.deepEqual(names, ["allowed-import-credentials.ts", "forbidden-import-credentials.ts"]);
  for (const name of names) {
    assert.equal(statSync(join(fixturesDir, name)).isFile(), true);
  }
});
