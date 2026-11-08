import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * 反方表（规格 §11）里，只有三条是能靠静态扫描回答的；其余十七条是行为题，
 * 各自由自己的功能用例覆盖，对照表在 `M-QUALITY-AUDIT.md`。这份文件负责那三条：
 *
 *  - **#20** 不得复活旧稿名（`MethodGuard` / `LearningDirective` / `TaskLearningPlan`）；
 *  - **#19** 家目录公式不得出现第二份；
 *  - **#12** 不得存在自动反思路径。
 *
 * 口径是「**先剥注释，再看代码**」。注释里写出 `MethodGuard` 是必须的——
 * `contracts.ts` 正是那条禁令的落点——注释里出现 `/learning/board` 也是必须的，
 * 因为 `integration/method/wiring.ts` 有一整段在解释**为什么它不自己算这个路径**。
 * 要拦的是会真的跑起来的那一份，不是提到它的那一句。
 *
 * 扫描器自己也要被扫（最后一条用例）：如果哪天目录改名让 `packageSources()`
 * 返回空数组，上面三条会**空转全绿**。让「扫到了几个文件」成为一个下界，把那种
 * 假绿变成一次红。
 */

const repoRoot = process.cwd();

/** 本包的两个独占目录前缀（规格 §12）。 */
const PACKAGE_DIRS: ReadonlyArray<string> = [
  "src/internal/learning/agent/subsystems/method",
];

/** Old-path bridges stay in scope until their protected consumers migrate. */
const COMPATIBILITY_DIRS = ["src/internal/learning/method", "src/internal/integration/method"];

/** 执行侧边界文件：`loop/method-*.ts`，测试文件不算。 */
const LOOP_DIR = "src/internal/loop";
const LOOP_PREFIX = "method-";

/** `AGENTS.md` 第 24 行明令不得自动恢复为正式合同的旧稿名。 */
const FORBIDDEN_NAMES: ReadonlyArray<string> = [
  "MethodGuard",
  "LearningDirective",
  "TaskLearningPlan",
];

/**
 * 家目录公式的指纹。
 *
 * `tryloHome` 的唯一一份住在 `surface/cli/session-paths.ts`，`integration/**` 与
 * 学习层都不许再拼一次——所以「`.trylo`」「`homedir(`」「`/learning/board`」这三个
 * 字面量在**代码**里零命中，才算没有第二个家。
 */
const HOME_MARKERS: ReadonlyArray<string> = ["homedir", ".trylo", "/learning/board"];

/**
 * 自动触发原语。
 *
 * `OPEN-M2-1` 说反思入口未实现，本包只保证「不存在自动路径」——那么保证就得是
 * 一句能被机器读的话：没有任何一个能让代码自己跑起来的定时器或排程原语。学习
 * 只在**一拍**上被问一次，问它的是执行侧，不是它自己。
 */
const AUTOMATIC_MARKERS: ReadonlyArray<string> = ["setInterval", "setTimeout", "cron"];

async function packageSources(): Promise<ReadonlyArray<string>> {
  const found: string[] = [];
  const directories = [...PACKAGE_DIRS, ...COMPATIBILITY_DIRS.filter((dir) => existsSync(path.join(repoRoot, dir)))];

  for (const dir of directories) {
    found.push(...await sourcesIn(dir));
  }

  for (const entry of await readdir(path.join(repoRoot, LOOP_DIR))) {
    if (entry.startsWith(LOOP_PREFIX) && entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      found.push(`${LOOP_DIR}/${entry}`);
    }
  }

  return found;
}

/** Recursion keeps every responsibility module under the original package rules. */
async function sourcesIn(dir: string): Promise<string[]> {
  const found: string[] = [];

  for (const entry of await readdir(path.join(repoRoot, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...await sourcesIn(file));
    } else if (entry.isFile() && file.endsWith(".ts") && !file.endsWith(".test.ts")) {
      found.push(file);
    }
  }

  return found;
}

/**
 * 剥掉注释，只留代码。
 *
 * 顺序不能反：先剥块注释再剥行注释。反过来的话，一个块注释里带 `//` 的句子会把
 * 注释的收尾一起吃进「行注释」里，于是块注释后半段被当成代码留下。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

async function offendersOf(markers: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
  const offenders: string[] = [];

  for (const file of await packageSources()) {
    const code = stripComments(await readFile(path.join(repoRoot, file), "utf8"));
    for (const marker of markers) {
      if (code.includes(marker)) {
        offenders.push(`${file}: ${marker}`);
      }
    }
  }

  return offenders;
}

test("#20: no production file in this package revives an old-draft name", async () => {
  assert.deepEqual(await offendersOf(FORBIDDEN_NAMES), []);
});

test("#19: the home formula has exactly one home, and it is not in this package", async () => {
  assert.deepEqual(await offendersOf(HOME_MARKERS), []);
});

test("#12: nothing in this package can run on its own clock", async () => {
  assert.deepEqual(await offendersOf(AUTOMATIC_MARKERS), []);
});

test("the scan actually covered the package, so the three above cannot pass by accident", async () => {
  const files = await packageSources();

  // 三个目录合起来十七个生产文件；取一个远低于真实值、又远高于 0 的下界，
  // 好让它只在「扫描器坏了」时红，不在「有人删了一个文件」时红。
  assert.equal(files.length >= 15, true, `only ${files.length} production files were scanned`);
  assert.equal(
    files.every((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")),
    true,
    "the scanner must never read a test file as if it were production",
  );
  assert.equal(
    files.some((file) => file.includes("/subsystems/method/domain/")),
    true,
    "the learning side must be in the scan",
  );
  assert.equal(
    files.some((file) => file.includes("/subsystems/method/adapters/")),
    true,
    "the adapter side must be in the scan",
  );
  assert.equal(
    files.some((file) => file.startsWith(`${LOOP_DIR}/${LOOP_PREFIX}`)),
    true,
    "the execution-side boundary files must be in the scan",
  );
});
