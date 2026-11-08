import assert from "node:assert/strict";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Verification Authority 的常驻架构扫描（WP-F §7 D1.4 / D2.6 / D5.12）。
 *
 * 这是「reader / writer 分权」从注释变成机器事实的地方。它约束的是**方向**，
 * 不是名字：只要签发能力（issue / revoke）出现在 integration、Board reducer 或
 * tooling 的 import 面上，独立验证门就重新退化成「调用方自报」——那正是外审 R2
 * 的 P1-R1 / P1-R2。
 *
 * 扫描强度（外审 R3 §3 P3-4 要求写成**实际**强度，不是「不可绕过」）：
 *   - module 说明符来自 **TypeScript 语法树**，不是正则扫文本：注释与字符串里的
 *     `from` / `import(` 不会产生噪声，`import("a" + "b")` 这种拼接实参也不再被
 *     截获成前半段——只要实参不是一个普通字符串字面量，就报**未解析**；
 *   - 写侧 token 的文本匹配在**拼接折叠后**的源码上做，`"Verification" +
 *     "AuthorityWriter"` 这类拆词别名会被折回原形；
 *   - 仍未覆盖：模板插值、`["A","B"].join("")`、`Reflect` / `eval` 式动态构造、
 *     以及 token 匹配本身无法区分「注释里提到」与「代码里使用」。
 * 因此这里的保证是「没有出现这些形状」，不是「不可能构造出这些形状」。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = await findRepoRoot(here);
const srcInternal = join(repoRoot, "src", "internal");

/** 写侧字样：出现即意味着签发能力进入了该层的可达面。 */
const WRITER_TOKENS = [
  "VerificationAuthorityWriter",
  "VerificationAuthorityRegistry",
  "createFileVerificationRegistry",
  "adapters/verification-authority-store",
  "verification-authority/issuance.js",
  "verification-authority/index.js",
];

/** 不得看到写侧的层。 */
const WRITER_FORBIDDEN_ROOTS = [
  join(srcInternal, "integration"),
  join(srcInternal, "learning", "control"),
  join(srcInternal, "tooling"),
  join(srcInternal, "learning", "domains"),
  // Preserve the restrictions of the original learning domains, integration
  // and tooling owners after relocation. Acquisition/evolution effect adapters
  // keep their original adapter ownership and are not promoted to issuers here.
  join(srcInternal, "learning", "agent", "subsystems", "method"),
  join(srcInternal, "learning", "agent", "subsystems", "tool", "domain"),
  join(srcInternal, "learning", "agent", "subsystems", "tool", "assets"),
  join(srcInternal, "learning", "agent", "subsystems", "tool", "runtime"),
  join(srcInternal, "learning", "agent", "subsystems", "tool", "adapters", "board"),
  join(srcInternal, "learning", "agent", "subsystems", "tool", "adapters", "events"),
  join(srcInternal, "learning", "agent", "subsystems", "tool", "adapters", "quarantine"),
  // This index loader was extracted from the original tooling discovery module.
  join(srcInternal, "learning", "agent", "subsystems", "tool", "adapters", "acquisition", "discovery-index.ts"),
];

/** 唯一允许看到写侧的目录：测试支撑需要一个真实持久 registry（组合根尚未存在）。 */
const WRITER_ALLOWED_PREFIXES = [join(srcInternal, "integration", "testing")];

const CONTRACT_ROOT = join(srcInternal, "learning", "verification-authority");
const STORE_ROOT = join(srcInternal, "adapters", "verification-authority-store");
const NODE_IO_PREFIXES = [
  "node:fs",
  "node:path",
  "node:os",
  "node:child_process",
  "node:net",
  "node:http",
  "node:https",
  "node:dgram",
  "node:worker_threads",
];

/**
 * 一个 module 说明符。`literal` 为 false 表示它**不是**一个普通字符串字面量
 * （拼接、模板字面量、变量…），因此扫描器无法证明它指向哪里，按最坏情况处理。
 */
type ImportSpecifier = {
  readonly text: string;
  readonly literal: boolean;
};

/** 相邻字符串字面量的 `+` 拼接，用于把拆词别名折回原形。 */
const CONCATENATED_LITERALS = /(["'])((?:\\.|(?!\1)[^\\])*)\1\s*\+\s*(["'])((?:\\.|(?!\3)[^\\])*)\3/g;

test("writer surface is unreachable from integration, board reducer and tooling", async () => {
  const violations: string[] = [];

  for (const root of WRITER_FORBIDDEN_ROOTS) {
    for (const file of await productionTs(root)) {
      if (WRITER_ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix))) {
        continue;
      }

      const source = await readFile(file, "utf8");
      // 在**拼接折叠后**的源码上匹配 token：`"Verification" + "AuthorityWriter"`
      // 这类字面量别名不能靠拆词绕过（外审 R3 §3 P3-4）。
      const collapsed = collapseStringConcatenation(source);

      for (const token of WRITER_TOKENS) {
        if (collapsed.includes(token)) {
          violations.push(`${rel(file)} reaches ${token}`);
        }
      }

      for (const specifier of importSpecifiers(source, file)) {
        if (!specifier.literal) {
          violations.push(`${rel(file)} has an unresolvable import specifier: ${specifier.text}`);
        }
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("board reducer stays independent of the verification authority", async () => {
  const violations: string[] = [];

  for (const file of await productionTs(join(srcInternal, "learning", "control"))) {
    const source = await readFile(file, "utf8");
    if (source.includes("verification-authority")) {
      violations.push(rel(file));
    }
  }

  assert.deepEqual(violations, []);
});

test("verification authority contract layer owns no store, adapter or IO dependency", async () => {
  const violations: string[] = [];

  for (const file of await productionTs(CONTRACT_ROOT)) {
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source, file)) {
      const target = specifier.text;
      if (target.includes("internal/adapters") || target.includes("adapters/")) {
        violations.push(`${rel(file)} imports adapter ${target}`);
      }

      if (target.includes("internal/integration") || target.includes("integration/")) {
        violations.push(`${rel(file)} imports integration ${target}`);
      }

      if (NODE_IO_PREFIXES.some((prefix) => target.startsWith(prefix))) {
        violations.push(`${rel(file)} imports IO module ${target}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("only the composition root and test support may construct a file registry", async () => {
  const violations: string[] = [];

  for (const file of await productionTs(srcInternal)) {
    if (file.startsWith(STORE_ROOT)) {
      continue;
    }

    if (WRITER_ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      continue;
    }

    // 按 module 说明符判断，而不是子串：注释里提到路径不算可达面。
    // 说明符必须是**普通字符串字面量**：拼接、模板字面量、先赋变量再 import 一律报
    // 未解析（外审 R3 §3 P3-4：旧扫描器只截获 `"../../adapters/" + "..."` 的前半段）。
    const source = await readFile(file, "utf8");

    for (const specifier of importSpecifiers(source, file)) {
      if (!specifier.literal) {
        violations.push(`${rel(file)} has an unresolvable import specifier: ${specifier.text}`);
        continue;
      }
      if (specifier.text.includes("adapters/verification-authority-store")) {
        violations.push(`${rel(file)} imports ${specifier.text}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("the scan is not fooled by literal-concatenation aliases", () => {
  // 把扫描器自己的折叠函数与说明符解析用在**合成源码**上：这是「扫描器确实能抓住
  // 外审 R3 §3 P3-4 的两种绕过」的证据，而不是「当前仓库恰好没有字面量」。
  const writerAlias = 'const T = "Verification" + "AuthorityWriter";\n';

  assert.equal(
    collapseStringConcatenation(writerAlias).includes("VerificationAuthorityWriter"),
    true,
    "token concatenation must be visible after folding",
  );

  const concatenated = importSpecifiers(
    'const target = "../../adapters/" + "verification-authority-store/index.js";\nvoid import(target);\n',
    "concatenated.ts",
  );

  assert.equal(concatenated.length, 1);
  assert.equal(concatenated[0]?.literal, false, "a specifier held in a variable must be unresolved");
  assert.equal(concatenated[0]?.text, "target");

  const inlineConcatenation = importSpecifiers(
    'void import("../../adapters/" + "verification-authority-store/index.js");\n',
    "inline.ts",
  );

  assert.equal(inlineConcatenation[0]?.literal, false, "an inline concatenation must be unresolved");
  // 旧扫描器在这里只截获到 `"../../adapters/"`，看不到拼接后的整条 store 路径。
  assert.match(inlineConcatenation[0]?.text ?? "", /\.\.\/\.\.\/adapters\/.*verification-authority-store/);

  assert.equal(
    importSpecifiers("void import(`./x.js`);\n", "template.ts")[0]?.literal,
    false,
    "a template literal is not a plain string literal",
  );

  // 反向对照：正常形态必须仍然解析成字面量，否则扫描会退化成「对所有人报错」。
  const named = importSpecifiers('import { a } from "./x.js";\n', "named.ts");

  assert.equal(named.length, 1);
  assert.equal(named[0]?.literal, true);
  assert.equal(named[0]?.text, "./x.js");

  // 注释与字符串里的 `from` / `import(` 不得被当成说明符（正则版做不到这一点）。
  const prose = importSpecifiers(
    '// 这条注释从 from "not/a/specifier.js" 里抄来的，还提到 import("x")\nconst label = "from \\"y\\"";\n',
    "prose.ts",
  );

  assert.deepEqual(prose, []);
});

test("reader port exposes exactly one capability and the writer exactly two", async () => {
  const source = await readFile(join(CONTRACT_ROOT, "contracts.ts"), "utf8");
  const reader = membersOf(source, "VerificationAuthorityReader");
  assert.deepEqual(reader, ["verify"]);
  const writer = membersOf(source, "VerificationAuthorityWriter");
  assert.deepEqual([...writer].sort(), ["issue", "revoke"]);
});

function membersOf(source: string, typeName: string): string[] {
  const start = source.indexOf(`export type ${typeName} = {`);
  assert.notEqual(start, -1, `${typeName} must be declared as an object type`);
  const end = source.indexOf("\n};", start);
  assert.notEqual(end, -1, `${typeName} must be closed`);
  const body = source.slice(start, end);
  return [...body.matchAll(/readonly\s+(\w+)\s*:/g)].map((match) => match[1] ?? "");
}

/**
 * 从**语法树**里读 module 说明符（外审 R3 §3 P3-4）。
 *
 * 正则版本有两个真实缺陷：(a) 注释与字符串里的 `from` / `import(` 会被当成说明符，
 * 于是扫描输出被噪声淹没；(b) `import("a" + "b")` 只会被截获成 `"a"`，拼接绕过
 * 完全不可见。改用 TypeScript 的解析器后，说明符就是语法树上的实参表达式：
 * **不是一个普通字符串字面量**（拼接 / 模板字面量 / 变量 / 空实参）就报未解析。
 */
function importSpecifiers(source: string, fileName: string): ImportSpecifier[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found: ImportSpecifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        found.push({ text: specifier.text, literal: true });
      }
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        found.push({ text: argument.text, literal: true });
      } else {
        found.push({ text: describeArgument(argument), literal: false });
      }
    }

    node.forEachChild(visit);
  };

  visit(file);

  return found;
}

/** 只用于错误消息：把无法解析的实参表达式原样摘一小段出来。 */
function describeArgument(argument: ts.Expression | undefined): string {
  if (argument === undefined) {
    return "<missing specifier>";
  }
  const raw = argument.getText().replace(/\s+/g, " ").trim();
  return raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
}

/**
 * 把相邻字符串字面量的 `+` 拼接折叠成一个字面量：`"A" + "B"` → `"AB"`。
 *
 * token 匹配只认字面量文本，因此把 token 拆成两半再拼起来是最省事的绕过手法
 * （外审 R3 §3 P3-4 的两种绕过之一）。折叠后这类别名重新出现在文本里。
 * 反复折叠到稳定为止，覆盖 `"A" + "B" + "C"`。
 *
 * 覆盖边界（诚实说明，不是「不可绕过」）：模板字面量插值、
 * `["A","B"].join("")` 与「先赋给变量再拼接」不在覆盖范围内。
 */
function collapseStringConcatenation(source: string): string {
  let current = source;

  for (let pass = 0; pass < 8; pass += 1) {
    const next = current.replace(CONCATENATED_LITERALS, (_match, quote, left, _other, right) =>
      `${quote}${left}${right}${quote}`,
    );
    if (next === current) {
      break;
    }

    current = next;
  }

  return current;
}

async function productionTs(root: string): Promise<string[]> {
  if ((await stat(root)).isFile()) return [root];

  const files: string[] = [];
  const pending: string[] = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }

    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(full);
      }
    }
  }

  return files;
}

function rel(file: string): string {
  return relative(repoRoot, file).split(sep).join("/");
}

/**
 * 测试从 `dist/**` 运行，层级随目录深度变化；向上找到真正含 `src/internal`
 * 的仓库根，而不是硬编码 `../..` 的层数。
 */
async function findRepoRoot(start: string): Promise<string> {
  let current = start;

  for (let depth = 0; depth < 8; depth += 1) {
    try {
      await access(join(current, "src", "internal"));
      return current;
    } catch {
      current = dirname(current);
    }
  }

  throw new Error(`cannot locate repository root above ${start}`);
}
