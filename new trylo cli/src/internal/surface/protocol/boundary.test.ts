import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

/**
 * 边界扫描（WP §6 末段）。
 *
 * `surface/protocol/**` 是**只读投影**，它的依赖方向必须窄到一眼能看完：
 * 协议合同（`internal/protocol/**`）+ 传输端口（`internal/ports/transport.ts`）
 * + 自己的同级文件。任何一条指向 loop / domain / cmd / CLI / adapters /
 * learning / journal / tooling / knowledge 的 import 都是架构越界。
 *
 * 检测器必须**有判别力**：光断言「0 命中」无法区分「真的干净」和「走错了目录」
 * 或「正则坏了」。所以这组用例另外断言「扫描确实看到了文件与说明符」，
 * 并用 `testdata/protocol/projection/architecture/**` 的两组夹具分别证明
 * 它会命中违规、且不误报合法依赖。这是 WP-F 外审留下的教训：
 * 一个只会通过的扫描器不是证据。
 */

/**
 * 锚在 `process.cwd()` 而不是 `import.meta.url`：仓库里读夹具的测试
 * （`protocol/protocol.test.ts`、`evaluation/boundary.test.ts`）都是这个口径，
 * 门禁也从仓库根运行。走错目录时下面的「文件太少」断言会**失败**而不是
 * 静默通过，所以这个选择不会把扫描变成空转。
 */
const repoRoot = process.cwd();
const surfaceProtocolDir = join(repoRoot, "src", "internal", "surface", "protocol");
const portFile = join(repoRoot, "src", "internal", "ports", "transport.ts");
const fixtureDir = join(repoRoot, "testdata", "protocol", "projection", "architecture");

/** 禁止出现在 import 路径里的目录名（逐一对应 WP §6 的清单）。 */
const FORBIDDEN_SEGMENTS = [
  "loop",
  "domain",
  "cmd",
  "cli",
  "adapters",
  "learning",
  "knowledge",
  "journal",
  "tooling",
  "evaluation",
  "integration",
];

/** 禁止的包（WP §6：无新依赖，尤其禁止 ws / express / SQLite / UI）。 */
const FORBIDDEN_PACKAGES = [
  "ws",
  "express",
  "better-sqlite3",
  "node:sqlite",
  "openai",
  "@anthropic-ai/sdk",
  "react",
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

function packageHits(specifier: string): ReadonlyArray<string> {
  return FORBIDDEN_PACKAGES.filter(
    (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
  );
}

/** 生产文件里出现的**裸包** import（既不是相对路径，也不是 node: 内置）。 */
function bareImports(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("node:");
}

function violationsIn(source: string): ReadonlyArray<string> {
  const violations: string[] = [];

  for (const specifier of importedSpecifiers(source)) {
    for (const segment of segmentHits(specifier)) {
      violations.push(`forbidden-layer:${segment} via ${specifier}`);
    }

    for (const pkg of packageHits(specifier)) {
      violations.push(`forbidden-package:${pkg} via ${specifier}`);
    }

    if (bareImports(specifier)) {
      violations.push(`bare-package-import via ${specifier}`);
    }
  }

  return violations;
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTs(full, acc);
      continue;
    }

    if (full.endsWith(".ts") && !full.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

test("投影层生产文件不 import 任何越界层、也不 import 裸包", () => {
  const files = walkTs(surfaceProtocolDir);

  assert.equal(files.length >= 7, true, `投影层文件太少（${files.length}），先确认目录没走错`);
  let specifierCount = 0;
  const violations: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    specifierCount += importedSpecifiers(source).length;
    for (const violation of violationsIn(source)) {
      violations.push(`${relative(repoRoot, file).replaceAll("\\", "/")} ${violation}`);
    }
  }

  assert.equal(specifierCount >= 10, true, "扫描到的 import 说明符太少，检测器可能失效");
  assert.deepEqual(violations, []);
});

test("传输端口不认识任何表面：ports 不得反向依赖 surface", () => {
  const source = readFileSync(portFile, "utf8");
  const specifiers = importedSpecifiers(source);
  assert.equal(specifiers.length >= 1, true, "ports/transport.ts 至少导入 protocol 的 JsonObject");
  for (const specifier of specifiers) {
    assert.equal(specifier.includes("surface"), false, specifier);
  }
});

test("检测器有判别力：两组违规夹具必须被命中", () => {
  const layerFixture = readFileSync(
    join(fixtureDir, "forbidden-import-loop-and-domain.ts"),
    "utf8",
  );
  const layerViolations = violationsIn(layerFixture);

  assert.equal(layerViolations.some((item) => item.startsWith("forbidden-layer:loop")), true);
  assert.equal(layerViolations.some((item) => item.startsWith("forbidden-layer:domain")), true);

  const cliFixture = readFileSync(
    join(fixtureDir, "forbidden-import-cli-and-adapters.ts"),
    "utf8",
  );
  const cliViolations = violationsIn(cliFixture);

  for (const layer of ["cli", "cmd", "adapters"]) {
    assert.equal(
      cliViolations.some((item) => item.startsWith(`forbidden-layer:${layer}`)),
      true,
      `夹具必须能命中 ${layer}`,
    );
  }

  const learningFixture = readFileSync(join(fixtureDir, "forbidden-import-learning.ts"), "utf8");
  const learningViolations = violationsIn(learningFixture);

  for (const layer of ["learning", "journal", "tooling", "knowledge"]) {
    assert.equal(
      learningViolations.some((item) => item.startsWith(`forbidden-layer:${layer}`)),
      true,
      `夹具必须能命中 ${layer}`,
    );
  }

  const packageFixture = readFileSync(
    join(fixtureDir, "forbidden-package-network.ts"),
    "utf8",
  );
  const packageViolations = violationsIn(packageFixture);

  for (const pkg of ["ws", "express", "better-sqlite3", "react"]) {
    assert.equal(
      packageViolations.some((item) => item.startsWith(`forbidden-package:${pkg}`)),
      true,
      `夹具必须能命中 ${pkg}`,
    );
  }
});

test("检测器不误报：合法依赖夹具必须零命中", () => {
  const source = readFileSync(
    join(fixtureDir, "allowed-import-protocol-and-ports.ts"),
    "utf8",
  );
  const specifiers = importedSpecifiers(source);

  assert.equal(specifiers.length, 4, "反向夹具自身必须能被解析出说明符");
  assert.deepEqual(violationsIn(source), []);
});
