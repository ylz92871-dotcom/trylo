import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const REQUIRED_GATES = [
  "四域有清晰输入/输出/不负责内容",
  "2 次 = proposal",
  "分类有正反例和 ambiguous",
  "generator 不能调用 Board activation",
  "evaluator 与 generator 边界可机器检查",
  "external verdict 与 model critique 类型分离",
  "current instruction precedence 与权限隔离",
  "skill/workflow 含失败经验与 provenance",
  "profile preview 冲突/token/确定性",
  "无真实 provider/network 和新增依赖",
  "作者审/反方审无 P0/P1",
  "RUN 按矩阵而非测试数",
];

test("C9 exit gates document cites all twelve gates and evidence paths", () => {
  const file = path.join(
    process.cwd(),
    "docs",
    "02-分期工程产出",
    "P01-协议与学习合同",
    "WP-C",
    "EXIT-GATES.md",
  );
  const text = readFileSync(file, "utf8");

  for (const gate of REQUIRED_GATES) {
    assert.equal(text.includes(gate), true, gate);
  }

  assert.match(text, /activationEligible/);
  assert.match(text, /boundary\.test\.ts/);
  assert.match(text, /do not call network/);
  assert.match(text, /io-boundary\.test\.ts/);
  assert.equal(/\btests \d+ pass/.test(text), false);
});

test("RUN.md audit scope names pipeline.ts and EXIT-GATES.md so doc gaps fail", () => {
  const wpDir = ["docs", "02-分期工程产出", "P01-协议与学习合同", "WP-C"];
  const runText = readFileSync(path.join(process.cwd(), ...wpDir, "RUN.md"), "utf8");

  assert.match(
    runText,
    /src\/internal\/learning\/pipeline\.ts/,
    "RUN.md audit scope must cover src/internal/learning/pipeline.ts",
  );
  assert.match(
    runText,
    /EXIT-GATES\.md/,
    "RUN.md audit scope must cover WP-C/EXIT-GATES.md",
  );
  assert.match(runText, /io-boundary\.test\.ts/);
});
