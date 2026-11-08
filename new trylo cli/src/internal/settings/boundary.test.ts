import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

/**
 * Boundary scan (WP §3, adversarial #11).
 *
 * The settings package must depend only on the protocol contracts, its own port,
 * and its sibling settings modules. Any import reaching `surface/cli`, `cmd`,
 * `loop`, `credentials`, `mcp`, `learning`, or `config/layers` is an architecture
 * violation — the WP chose *zero* import of `config/layers.ts` so this loader is
 * not coupled to the old four-layer merge.
 *
 * The scanner is made *discriminating* on purpose: asserting "0 hits" alone cannot
 * tell a clean tree from a wrong directory or a broken regex. So the same detector
 * is run against two fixtures under `testdata/settings/architecture/` — one that
 * must light up on every forbidden layer, and one that must stay dark. A scanner
 * that only ever passes is not evidence.
 */

const repoRoot = process.cwd();
const settingsDir = join(repoRoot, "src", "internal", "settings");
const portFile = join(repoRoot, "src", "internal", "ports", "settings.ts");
const adapterFile = join(repoRoot, "src", "internal", "adapters", "settings-fs.ts");
const fixtureDir = join(repoRoot, "testdata", "settings", "architecture");

/** Directory segments forbidden in an import specifier (WP §3 forbidden list). */
const FORBIDDEN_SEGMENTS = [
  "surface",
  "cli",
  "cmd",
  "loop",
  "credentials",
  "mcp",
  "learning",
  "config",
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

function productionFiles(): ReadonlyArray<string> {
  const files: string[] = [];

  for (const entry of readdirSync(settingsDir)) {
    const full = join(settingsDir, entry);
    if (statSync(full).isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts")) {
      files.push(full);
    }
  }

  files.push(portFile, adapterFile);

  return files;
}

test("settings package imports no forbidden layer and no bare package", () => {
  const files = productionFiles();

  // 6 settings modules + the port + the adapter; fewer means the directory moved.
  assert.equal(files.length >= 8, true, `too few files scanned (${files.length})`);
  let specifierCount = 0;
  const violations: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    specifierCount += importedSpecifiers(source).length;
    for (const violation of violationsIn(source)) {
      violations.push(`${relative(repoRoot, file).replaceAll("\\", "/")} ${violation}`);
    }
  }

  assert.equal(specifierCount >= 15, true, "too few specifiers scanned; detector may be broken");
  assert.deepEqual(violations, []);
});

test("no file imports config/layers (the WP chose zero coupling to the old loader)", () => {
  for (const file of productionFiles()) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importedSpecifiers(source)) {
      assert.equal(
        specifier.replaceAll("\\", "/").includes("config/layers"),
        false,
        `${relative(repoRoot, file)} imports ${specifier}`,
      );
    }
  }
});

test("detector is discriminating: the forbidden fixture lights up on every layer", () => {
  const source = readFileSync(join(fixtureDir, "forbidden-import-settings.ts"), "utf8");
  const violations = violationsIn(source);

  for (const segment of FORBIDDEN_SEGMENTS) {
    assert.equal(
      violations.some((item) => item.startsWith(`forbidden-layer:${segment}`)),
      true,
      `fixture must trigger ${segment}`,
    );
  }
});

test("detector does not false-positive: the allowed fixture is clean", () => {
  const source = readFileSync(join(fixtureDir, "allowed-import-settings.ts"), "utf8");
  const specifiers = importedSpecifiers(source);
  assert.equal(specifiers.length, 3, "the allowed fixture itself must parse to three specifiers");
  assert.deepEqual(violationsIn(source), []);
});
