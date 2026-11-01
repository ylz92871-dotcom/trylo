import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { REASON_CODES } from "../../learning/control/reasons.js";
import {
  RECEIPT_FAILURE_CODES,
  RECEIPT_ISSUANCE_FAILURE_CODES,
} from "../../learning/verification-authority/contracts.js";
import { MAPPING_FAILURE_REASONS } from "./rejection.js";

/**
 * 失败码卫生门（外审 R2 §4.2 的机器化形式，外审 R3 §3 P3-1 的收紧）。
 *
 * 「只定义、无产生点」的失败码是审计里最容易被指为口径漂移的一类债：它让
 * 文档声称的失败面比代码实际能产生的更大。这里把它变成一条常驻断言——
 * 任何新增的孤立失败码都会立刻失败，除非显式登记为待产生。
 *
 * R3 收紧的**判定口径**：一次出现只有在**运行时值位置**才算产生点。
 * 旧实现只做文本包含，于是 `learning-store/codec.ts` 里 `type X = "checksum_mismatch"
 * | "torn_write" | "sequence_gap"` 这样的**类型联合成员**也被当成了产生点，
 * `torn_write` 因此悄悄成为第 8 个孤儿码却无人发现。现在用 TypeScript 自己的
 * 解析器判定：字符串字面量的祖先链上只要有 `TypeNode`，它就是「提到」而不是「产生」。
 *
 * 这个门禁**不能**证明「不存在死码」，它证明的是「每个码都有一个运行时字面量出现
 * 在允许的目录里」。值位置上的纯清单（例如某个 `const CODES = ["a","b"]`）仍会被
 * 计入——这是文本/语法级扫描与语义级可达性分析之间的差额，已写在 WP-F/QUALITY-AUDIT.md。
 */

/** 定义文件里逐个列出的失败码枚举。 */
type EnumSpec = {
  readonly name: string;
  readonly file: string;
  readonly codes: readonly string[];
  /** 显式登记为「已声明但尚无产生点」的码，必须附理由。 */
  readonly pending: readonly string[];
  /**
   * 「产生点」必须落在这个目录集合里。用于区分**产生**与**提到**：
   * 映射表里出现一个失败码不等于有人能返回它（`receipt_stale_subject` 就是这样
   * 活过一轮外审的）。省略表示全库任意生产文件都算。
   */
  readonly producerRoots?: readonly string[];
};

const AUTHORITY_ROOTS = [
  path.join("internal", "learning", "verification-authority"),
  path.join("internal", "adapters", "verification-authority-store"),
];

const ENUMS: readonly EnumSpec[] = [
  {
    name: "MAPPING_FAILURE_REASONS",
    file: path.join("internal", "integration", "contract", "rejection.ts"),
    codes: MAPPING_FAILURE_REASONS,
    pending: [],
  },
  {
    name: "RECEIPT_FAILURE_CODES",
    file: path.join("internal", "learning", "verification-authority", "contracts.ts"),
    codes: RECEIPT_FAILURE_CODES,
    pending: [],
    producerRoots: AUTHORITY_ROOTS,
  },
  {
    name: "RECEIPT_ISSUANCE_FAILURE_CODES",
    file: path.join("internal", "learning", "verification-authority", "contracts.ts"),
    codes: RECEIPT_ISSUANCE_FAILURE_CODES,
    pending: [],
    producerRoots: AUTHORITY_ROOTS,
  },
  {
    // Board 的 reason 会进入 learning-store 持久事件，因此**收窄等于一次持久格式
    // 迁移**，按 WP §12 不得在本包内顺手做。这里保证的是：**每个码要么有运行时
    // 产生点，要么被显式登记为已知孤立码**——即「不再新增**未登记**的孤立码」。
    // 它不证明「不存在死码」（见文件头对判定强度的说明）。
    // 详见 WP-F/QUALITY-AUDIT.md §3.5。
    name: "REASON_CODES",
    file: path.join("internal", "learning", "control", "reasons.ts"),
    codes: REASON_CODES,
    pending: [
      // 无对应守卫缺口，只是历史上用了别的码或把幂等建模成成功：
      "duplicate_asset", // 重复版本号实际由 active_content_immutable 拦截
      "idempotent_replay", // 重复 commandId 建模为 replay() 成功，不是失败
      "evidence_not_found", // record_evidence 只按 proposal 定位
      // 2026-09-21 起 `snapshot_corrupt` 有了真实产生点：learning-store codec 的
      // 读边界（不可解析 / 形状外来的行 fail-closed），不再是孤立码，故移出清单。
      "lock_unavailable", // store 锁冲突实际报 multi_writer
      // 外审 R3 §3 P3-1：`torn_write` 在 src 内没有任何运行时候选产生点，唯一出现是
      // `adapters/learning-store/codec.ts` 的类型联合成员。它的**产生权在 learning-store**
      // ——那个适配器不属于本包写入集（WP §8），因此本包不能给它加产生点，也不改它。
      "torn_write",
      // RW1: collect_disabled / learning_aborted now have real runtime producers in
      // integration/reward/gateway.ts and appraisal.ts; neither remains pending.
    ],
  },
];

/** 已退役的失败码：不得重新出现在活跃联合里（契约收窄记录）。 */
const RETIRED_MAPPING_REASONS = ["self_generated_verdict", "verdict_contradiction"] as const;

test("retired mapping reasons stay out of the live union", () => {
  for (const retired of RETIRED_MAPPING_REASONS) {
    assert.equal(
      (MAPPING_FAILURE_REASONS as readonly string[]).includes(retired),
      false,
      retired,
    );
  }
});

for (const spec of ENUMS) {
  test(`${spec.name} has no undeclared dead code`, async () => {
    const root = process.cwd();
    const files = await listTs(path.join(root, "src"));
    const sources = await Promise.all(
      // 测试文件不算产生点：一条只在测试里被引用的失败码仍然是死码，
      // 而且本文件的 pending 清单会自引用，必须排除掉。
      files
        .filter((file) => !file.endsWith(".test.ts"))
        .map(async (file) => ({
          file,
          literals: runtimeStringLiterals(await readFile(file, "utf8"), file),
        })),
    );
    const declaring = path.resolve(root, "src", spec.file);
    const allowedRoots =
      spec.producerRoots === undefined
        ? undefined
        : spec.producerRoots.map((entry) => path.resolve(root, "src", entry));

    const dead: string[] = [];
    for (const code of spec.codes) {
      let producers = 0;
      for (const { file, literals } of sources) {
        const resolved = path.resolve(file);
        if (resolved === declaring) {
          continue;
        }
        if (allowedRoots !== undefined && !allowedRoots.some((base) => resolved.startsWith(base))) {
          continue;
        }
        producers += literals.has(code) ? 1 : 0;
      }
      if (producers === 0) {
        dead.push(code);
      }
    }

    assert.deepEqual(
      [...dead].sort(),
      [...spec.pending].sort(),
      `${spec.name}: every code needs a runtime producer, or an explicit entry in ENUMS[].pending`,
    );
  });
}

/**
 * 该文件里以**运行时值**出现的字符串字面量集合。
 *
 * 用 TypeScript 自己的解析器而不是文本包含，正是为了区分「产生」与「提到」
 * （外审 R3 §3 P3-1）：字符串字面量的祖先链上只要出现 `TypeNode`，它就是类型
 * 联合 / 类型实参里的成员，不可能是返回值。注释属于 trivia，不会进入 AST，
 * 因此注释里的码也自动不算。模板字面量（无插值）与普通字面量一视同仁。
 */
function runtimeStringLiterals(source: string, fileName: string): ReadonlySet<string> {
  const found = new Set<string>();
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isTypePosition(node)) {
      found.add(node.text);
    }
    node.forEachChild(visit);
  };
  visit(file);
  return found;
}

/** 字面量是否处于类型位置：祖先链上出现任何 `TypeNode` 即为「只是提到」。 */
function isTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isTypeNode(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

async function listTs(target: string): Promise<string[]> {
  const info = await stat(target);
  if (info.isFile()) {
    return target.endsWith(".ts") ? [target] : [];
  }
  const entries = await readdir(target, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTs(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}
