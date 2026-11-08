import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * 工作包 §10 里答「代码事实」而不是「行为」的那三条，用测试写，不用散文写。
 *
 * 三条都是「不许出现第二份 / 不许悄悄长大」型的断言，行为用例很难一击即中，
 * 静态扫描可以：
 *
 * - **#12（本包授权后修正）** 原禁令是「MCP 不得被接进工具端口」；该决定已由业主解封（WP-MCP 运行时通电 §4），
 *   因此它变成「谁可以接」的白名单：`ports/tools.ts` 契约仍不认识 MCP，且除组合层外无人把它接进工具端口。

 * - **#25** `args.ts` / `usage.ts` 不得超过 400 行，且本包写入集里的生产文件都不许超。
 * - **#26** `runner.ts`（540）/ `reduce.ts`（643）只许拆出去，净行数不得增加。
 *
 * 有了这三条，越界就是下一次 `npm run quality:new-cli` 里的一个红，而不是审计方
 * 需要自己去数行数、自己去 grep 的一件事。
 *
 * 扫描一律**先剥注释再扫代码**：禁令的落点就在注释里，不剥会把禁令本身当成违规。
 */

const repoRoot = process.cwd();

/** 体积纪律作用的目录：本包写入集里的生产代码。 */
const SCANNED_DIRS: ReadonlyArray<string> = [
  "src/internal/surface/cli",
  "src/internal/domain",
  "src/internal/loop",
  "src/cmd/trylo",
];

/** 工作包 §10 #25 点名的两个文件。 */
const NAMED_IN_25: ReadonlyArray<string> = [
  "src/internal/surface/cli/args.ts",
  "src/internal/surface/cli/usage.ts",
];

/**
 * 例外：这两个文件的纪律是「净行数不得增加」（工作包 §8），不是 400。
 * 括号里的数是它们在本包开工时的行数。
 */
const FROZEN_CEILINGS: ReadonlyArray<readonly [file: string, ceiling: number]> = [
  ["src/internal/loop/runner.ts", 540],
  ["src/internal/domain/reduce.ts", 643],
];

const FILE_LIMIT = 400;

/** 扫描覆盖面下界，防止目录改名让扫描空转全绿。 */
const MIN_SCANNED_FILES = 60;

test("#25: the argument and usage surfaces stay inside their own file", async () => {
  for (const file of NAMED_IN_25) {
    const lines = lineCount(await sourceOf(file));
    assert.equal(lines <= FILE_LIMIT, true, `${file} is ${lines} lines; the limit is ${FILE_LIMIT}`);
  }
});

test("#25: every production file in this package stays inside the file limit", async () => {
  const frozen = new Set(FROZEN_CEILINGS.map(([file]) => file));
  const scanned = await productionSourcesOf(SCANNED_DIRS);

  assert.equal(
    scanned.length >= MIN_SCANNED_FILES,
    true,
    `only ${scanned.length} files were scanned; the floor is ${MIN_SCANNED_FILES}`,
  );

  for (const dir of SCANNED_DIRS) {
    assert.equal(
      scanned.some((file) => file.startsWith(`${dir}/`)),
      true,
      `nothing was scanned under ${dir}`,
    );
  }

  const offenders: Array<string> = [];

  for (const file of scanned) {
    if (frozen.has(file)) {
      continue;
    }

    const lines = lineCount(await sourceOf(file));
    if (lines > FILE_LIMIT) {
      offenders.push(`${file} is ${lines} lines`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("#26: the two frozen files never grow past the size this package opened with", async () => {
  for (const [file, ceiling] of FROZEN_CEILINGS) {
    const lines = lineCount(await sourceOf(file));
    assert.equal(lines <= ceiling, true, `${file} is ${lines} lines; the freeze is ${ceiling}`);
  }
});

test("#12 (amended): only the composition layer may name MCP beside the tool port", async () => {
  const toolPort = await sourceOf("src/internal/ports/tools.ts");

  assert.equal(
    /\bmcp\b/i.test(stripComments(toolPort)),
    false,
    "the tool port contract now names MCP; the port itself must stay ignorant of it",
  );
  const all = await productionSourcesOf(["src"]);

  assert.equal(all.length >= 200, true, `only ${all.length} sources were scanned`);
  const binders: Array<string> = [];
  const offenders: Array<string> = [];

  for (const file of all) {
    const code = stripComments(await sourceOf(file));
    if (!/\bports\/tools\.js/.test(code)) {
      continue;
    }

    binders.push(file);

    if (/\bmcp\b/i.test(code) && !isGrantedBindingSite(file)) {
      offenders.push(file);
    }
  }

  // 自检：这条断言只有在真的扫到了绑定工具端口的文件时才有判别力。
  assert.equal(binders.length >= 5, true, `only ${binders.length} files bind the tool port`);
  assert.deepEqual(offenders, []);
  // 自检：白名单本身也得被扫到并且确实命名了两者，否则它只是一段过期散文。
  const granted = binders.filter(isGrantedBindingSite);

  for (const file of MCP_BINDING_GRANTED) {
    assert.equal(granted.includes(file), true, `${file} no longer binds the tool port; the grant is stale`);
  }
});

/**
 * 谁被允许同时命名 MCP 与工具端口。
 *
 * 原禁令（「MCP 不得被接进工具端口」）出自传统 CLI 三轨并行那一波的派工单：当时
 * 「MCP 进 ToolPort / snapshot」被列为**产品决定**，所以在决定作出前用一条门把它
 * 钉成红。`2026-09-16-WP-传统CLI-MCP运行时通电.md` §4 记录了该决定已由所有者解封，
 * 本包就是它的落地：MCP 工具**就是**工具表里的一行，组合层必须同时认识两者。
 *
 * 所以这条门从「禁令」变成「白名单 + 禁令」，授权面窄到四个文件——运行时的三个
 * 生产模块，以及唯一把它接进 `LoopPorts` 的组合根。除此之外，任何绑定工具端口的
 * 文件出现 MCP 字样仍然是违规，`ports/tools.ts` 契约本身也仍然不认识 MCP。
 */
const MCP_BINDING_GRANTED: ReadonlyArray<string> = [
  "src/internal/surface/cli/wiring.ts",
  // Canonical composition DTOs moved verbatim out of wiring.ts. This type-only
  // module has the same owner; it introduces no new runtime binding authority.
  "src/internal/surface/cli/wiring-input.ts",
  "src/internal/adapters/mcp-runtime/mount.ts",
  "src/internal/adapters/mcp-runtime/execute.ts",
  "src/internal/adapters/mcp-runtime/index.ts",
  // Progressive discovery composes the same original MCP execution/resource
  // ports; it is an adapter, not a second executor or permission owner.
  "src/internal/adapters/mcp-runtime/progressive.ts",
  // The library names MCP as read-only origin metadata and projects the live
  // catalog. Neither module grants authority or mounts a new executor.
  "src/internal/tooling/library/contracts.ts",
  "src/internal/tooling/library/host/sources.ts",
  // The fourth runtime module, split out of `index.ts`: it owns the three
  // `mcp_*` resource tools, so it both binds the tool port and names them. Same
  // category as the three above — a production module of the runtime — which is
  // why the grant is widened here rather than the file being renamed to dodge
  // the check. A tool whose name is `mcp_read_resource` cannot avoid the word.
  "src/internal/adapters/mcp-runtime/resources.ts",
];

function isGrantedBindingSite(file: string): boolean {
  return MCP_BINDING_GRANTED.includes(file);
}

async function sourceOf(relative: string): Promise<string> {
  return readFile(path.join(repoRoot, relative), "utf8");
}

/** 与 `wc -l` 同口径：末尾换行不算一行。 */
function lineCount(source: string): number {
  const lines = source.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** 先剥块注释、再剥行注释；顺序反了会把块注释的收尾吃进行注释。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** 目录下的生产源文件（递归，排除测试）。 */
async function productionSourcesOf(dirs: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
  const found: Array<string> = [];
  for (const dir of dirs) {
    await collect(dir, found);
  }
  return found.sort();
}

async function collect(relative: string, found: Array<string>): Promise<void> {
  for (const entry of await readdir(path.join(repoRoot, relative), { withFileTypes: true })) {
    const next = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      await collect(next, found);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push(next);
    }
  }
}
