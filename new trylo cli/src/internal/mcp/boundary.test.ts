import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Boundary scan (WP §5.5, adversarial #12).
 *
 * The MCP package is a replacable library, not part of the loop. It may depend
 * on `node:*` and on the protocol/port contracts it owns, and on nothing else:
 * a `loop`, `surface/cli`, `cmd`, `learning`, `tooling` or `ports/tools` import
 * is an architecture violation. It may not pull a bare package either — this
 * package ships with zero runtime dependencies.
 *
 * The scanner is made discriminating on purpose: two fixtures under
 * `testdata/mcp/architecture/` — one that must light up on every forbidden
 * layer, one that must stay dark — so a scanner that only ever passes is not
 * mistaken for evidence.
 */

const repoRoot = process.cwd();
const SRC = join(repoRoot, "src", "internal");
const PACKAGES = [
  join(SRC, "mcp"),
  join(SRC, "adapters", "mcp-registry"),
  join(SRC, "adapters", "mcp-stdio"),
  join(SRC, "adapters", "mcp-http"),
];
const PORT_FILES = [join(SRC, "ports", "mcp-registry.ts"), join(SRC, "ports", "mcp-client.ts")];
const FIXTURE_DIR = join(repoRoot, "testdata", "mcp", "architecture");

/** Directory segments that must never appear in an import specifier. */
const FORBIDDEN_SEGMENTS = ["loop", "surface", "cli", "cmd", "learning", "tooling"];
/** The exact ToolPort file, forbidden as a whole rather than by segment. */
const FORBIDDEN_TARGETS = ["ports/tools"];

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

function isBarePackage(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("node:");
}

/**
 * Removes comments before scanning so prose like `a different question from
 * "will it run"` can never be misread as an import specifier. The sources under
 * test carry no `//` inside a string literal, so a token-blind strip is safe.
 */
function stripComments(source: string): string {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock.replace(/\/\/[^\n]*/g, "");
}

function violationsIn(source: string): ReadonlyArray<string> {
  const violations: string[] = [];

  for (const specifier of importedSpecifiers(stripComments(source))) {
    const segments = specifier.replaceAll("\\", "/").split("/");

    for (const segment of FORBIDDEN_SEGMENTS) {
      if (segments.includes(segment)) {
        violations.push(`forbidden-layer:${segment} via ${specifier}`);
      }
    }

    for (const target of FORBIDDEN_TARGETS) {
      if (specifier.replaceAll("\\", "/").includes(target)) {
        violations.push(`forbidden-target:${target} via ${specifier}`);
      }
    }

    if (isBarePackage(specifier)) {
      violations.push(`bare-package-import via ${specifier}`);
    }
  }

  return violations;
}

function productionFiles(): ReadonlyArray<string> {
  const files: string[] = [];

  for (const dir of PACKAGES) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts")) {
        files.push(full);
      }
    }
  }

  files.push(...PORT_FILES);

  return files;
}

test("mcp package imports no forbidden layer, no ports/tools, no bare package", () => {
  const files = productionFiles();

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

test("detector is discriminating: the forbidden fixture lights up on every layer", () => {
  const source = readFileSync(join(FIXTURE_DIR, "forbidden-import-mcp.ts"), "utf8");
  const violations = violationsIn(source);

  for (const segment of FORBIDDEN_SEGMENTS) {
    assert.equal(
      violations.some((item) => item.startsWith(`forbidden-layer:${segment}`)),
      true,
      `fixture must trigger ${segment}`,
    );
  }

  assert.equal(violations.some((item) => item.includes("ports/tools")), true);
  assert.equal(violations.some((item) => item.startsWith("bare-package-import")), true);
});

test("detector does not false-positive: the allowed fixture is clean", () => {
  const source = readFileSync(join(FIXTURE_DIR, "allowed-import-mcp.ts"), "utf8");
  const specifiers = importedSpecifiers(source);
  assert.equal(specifiers.length >= 2, true, "the allowed fixture must parse to several specifiers");
  assert.deepEqual(violationsIn(source), []);
});
