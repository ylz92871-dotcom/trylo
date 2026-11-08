import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * 体积预算，用测试写而不是用承诺写。
 *
 * 工作包要求 `runner.ts` 只减不增（M1 收工 542 行），且每个新文件 ≤ 400 行、
 * 每个新函数 ≤ 60 行。两个数都住在这里，所以越过它们是一次**红**，而不是审计
 * 文档里一段要记得去读的话。改这里的数字因此必须是一个人在 diff 里、手里拿着
 * 工作包规则做出的决定，而不是一次一行悄悄发生的漂移。
 *
 * 第三条测的是**方向**而不是大小：`control/**`、`domain/reduce.ts` 与表面的
 * `projection.ts` 都属于冻结面，一条从它们指向本包的 import 就是把学习塞回了
 * 它不该在的层。这条即使全绿也不能证明「本包写入集外零命中」——那件事只能由
 * `git status` 说——但它能挡住最容易发生的那一种越界。
 */

const repoRoot = process.cwd();

/** `runner.ts` 在 M2 开工时的行数（M1 交付清单：`545→542`）。 */
const RUNNER_BASELINE_LINES = 542;

const METHOD_PREFIXES = ["agent/subsystems/method/", "learning/method/", "loop/method-", "integration/method/"];
// The upgraded method domain owns its policy. Board's canonical persistence
// boundary delegates pure validation through these exact seams, never IO or orchestration.
const METHOD_BOARD_SEAMS: Readonly<Record<string, readonly string[]>> = {
  "commands.ts": ["experience-facts", "inference", "exposure-binding"], "contracts.ts": ["inference", "exposure-binding"],
  "events.ts": ["experience-facts"],
  "state.ts": ["experience-facts", "inference", "experience-source"],
  "apply-method-ledger.ts": ["inference", "experience-source", "exposure-binding"],
  "apply-method-experience.ts": ["experience-facts", "experience-state", "experience-source"],
};

const NEW_FILES: ReadonlyArray<string> = [
  "src/internal/learning/agent/subsystems/method/domain/contracts.ts",
  "src/internal/learning/agent/subsystems/method/domain/niche.ts",
  "src/internal/learning/agent/subsystems/method/domain/vocabulary.ts",
  "src/internal/learning/agent/subsystems/method/domain/release.ts",
  "src/internal/learning/agent/subsystems/method/domain/gate.ts",
  "src/internal/learning/agent/subsystems/method/domain/gate-draft.ts",
  "src/internal/learning/agent/subsystems/method/assets/archive.ts",
  "src/internal/learning/agent/subsystems/method/orchestration/compile.ts",
  "src/internal/learning/agent/subsystems/method/orchestration/board.ts",
  "src/internal/learning/agent/subsystems/method/orchestration/board-write.ts",
  "src/internal/learning/agent/subsystems/method/orchestration/board-ledger.ts",
  "src/internal/learning/agent/subsystems/method/port.ts",
  "src/internal/loop/method-channel.ts",
  "src/internal/loop/method-feedback-channel.ts",
  "src/internal/loop/method-signal.ts",
  "src/internal/loop/method-port.ts",
  "src/internal/loop/method-attribution.ts",
  "src/internal/loop/method-execution-span.ts",
  "src/internal/loop/method-context-cue.ts",
  "src/internal/learning/agent/subsystems/method/adapters/board-writer.ts",
  ...["experience-feedback", "experience-correction", "experience-revision", "experience-store", "experience-model",
    "experience-tools", "experience-funding", "funding-identity", "experience-budget", "review-instruction", "review-material", "context-result-budget"].map(name =>
    `src/internal/learning/agent/subsystems/method/adapters/${name}.ts`),
  ...["experience-runtime", "experience-review", "experience-effects", "experience-selection", "experience-expand", "experience-trace",
    "adoption-window", "board-slot"].map(name => `src/internal/learning/agent/subsystems/method/orchestration/${name}.ts`),
  ...["experience-facts", "experience-source", "experience-state", "inference", "inference-observations", "scope-learning",
    "adoption-coverage", "adoption-window", "application-report", "change-detection", "compilation-block", "compilation-evidence",
    "compilation-review", "execution-trace", "experience-render", "exposure-binding", "feedback-adoption", "model-error",
    "opportunity-representative", "procedure", "recompile-policy", "review-admission", "review-information", "review-progress",
    "scope-description", "scope-retrieval", "scope-state", "source-trial-policy"]
    .map(name => `src/internal/learning/agent/subsystems/method/domain/${name}.ts`),
];

/** 冻结面：本包不得成为它们的依赖。 */
const FROZEN_SOURCES: ReadonlyArray<string> = [
  "src/internal/domain/reduce.ts",
  "src/internal/learning/control/reducer.ts",
  "src/internal/learning/control/state.ts",
  "src/internal/surface/cli/projection.ts",
];

const FILE_LIMIT = 400;
const FUNCTION_LIMIT = 60;

async function sourceOf(relative: string): Promise<string> {
  return readFile(path.join(repoRoot, relative), "utf8");
}

test("the runner is no longer than it was when this package opened", async () => {
  const lines = (await sourceOf("src/internal/loop/runner.ts")).split("\n").length;
  assert.equal(
    lines <= RUNNER_BASELINE_LINES,
    true,
    `runner.ts is ${lines} lines; the freeze is ${RUNNER_BASELINE_LINES}`,
  );
});

test("every new file stays inside the file limit", async () => {
  for (const file of NEW_FILES) {
    const lines = (await sourceOf(file)).split("\n").length;
    assert.equal(lines <= FILE_LIMIT, true, `${file} is ${lines} lines; the limit is ${FILE_LIMIT}`);
  }
});

test("every new function stays inside the function limit", async () => {
  for (const file of NEW_FILES) {
    for (const [name, lines] of topLevelFunctions(await sourceOf(file))) {
      assert.equal(
        lines <= FUNCTION_LIMIT,
        true,
        `${file}:${name} is ${lines} lines; the limit is ${FUNCTION_LIMIT}`,
      );
    }
  }
});

test("frozen layers only delegate method validation through enumerated pure Board seams", async () => {
  const offenders: string[] = [];

  for (const file of [...FROZEN_SOURCES, ...(await controlSources())]) {
    const source = await sourceOf(file);
    for (const specifier of importedSpecifiers(source)) {
      if (METHOD_PREFIXES.some((prefix) => specifier.includes(prefix))) {
        const allowed = file.startsWith("src/internal/learning/control/") &&
          (METHOD_BOARD_SEAMS[path.basename(file)] ?? []).some(name =>
            specifier === `../agent/subsystems/method/domain/${name}.js`);
        if (allowed) continue;
        offenders.push(`${file} -> ${specifier}`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});

async function controlSources(): Promise<ReadonlyArray<string>> {
  const dir = path.join(repoRoot, "src", "internal", "learning", "control");
  return (await readdir(dir))
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => `src/internal/learning/control/${entry}`);
}

function importedSpecifiers(source: string): ReadonlyArray<string> {
  const found: string[] = [];

  for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)) {
    if (match[1] !== undefined) {
      found.push(match[1]);
    }
  }

  return found;
}

/**
 * 一个源文件的顶层函数及其长度。
 *
 * 函数从第 0 列的 `function` 声明开始，到第 0 列的收尾大括号结束：代码里所有
 * 缩进的东西——块、对象字面量、switch 分支——都落在两者之间，所以这两行恰好
 * 夹住一个函数。
 */
function topLevelFunctions(source: string): ReadonlyArray<[name: string, lines: number]> {
  const lines = source.split("\n");
  const found: Array<[string, number]> = [];
  let open: { readonly name: string; readonly start: number } | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const declaration = /^(?:export )?(?:async )?function (\w+)/.exec(line);
    if (declaration !== null) {
      open = { name: declaration[1] ?? "?", start: index };
      continue;
    }

    if (line === "}" && open !== undefined) {
      found.push([open.name, index - open.start + 1]);
      open = undefined;
    }
  }

  return found;
}
