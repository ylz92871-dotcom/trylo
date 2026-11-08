import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createNodeInstructionReader } from "./instruction-reader.js";
import { expandInstructionImports } from "./imports.js";

/**
 * `@path` imports in project instruction files (WP14 / L50).
 *
 * Proven against a real temporary directory: the point is that files on disk
 * are found, read and expanded with the platform's own path resolution — a fake
 * reader would only prove that a fake works. Whole-line references only, with a
 * workspace containment boundary, a cycle guard, a depth bound and one shared
 * byte budget across the whole expansion tree.
 */

let workspace = "";

before(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "trylo-import-ws-"));
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function write(relativePath: string, text: string): string {
  const absolute = path.join(workspace, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
  return absolute;
}

function expand(
  text: string,
  baseDirectory = workspace,
  maxTotalImportBytes?: number,
): ReturnType<typeof expandInstructionImports> {
  return expandInstructionImports({
    text,
    baseDirectory,
    workspaceRoot: workspace,
    reader: createNodeInstructionReader(),
    ...(maxTotalImportBytes === undefined ? {} : { maxTotalImportBytes }),
  });
}

test("a whole-line relative import is replaced by the imported text", () => {
  write("more.md", "imported rules");
  const result = expand("top rules\n@./more.md\nafter");
  assert.equal(result.text, "top rules\nimported rules\nafter");
  assert.equal(result.problems.length, 0);
});

test("a bare @name resolves relative to the importing file's directory", () => {
  write(path.join("docs", "glossary.md"), "terms");
  const result = expand("@glossary.md", path.join(workspace, "docs"));
  assert.equal(result.text, "terms");
});

test("nested imports expand depth-first", () => {
  write("a.md", "A\n@./b.md");
  write("b.md", "B");
  const result = expand("@./a.md");
  assert.equal(result.text, "A\nB");
});

test("an import cycle is cut, not looped on", () => {
  write("cyc-a.md", "A\n@./cyc-b.md");
  write("cyc-b.md", "B\n@./cyc-a.md");
  const result = expand("@./cyc-a.md");
  assert.equal(result.text, "A\nB");
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? "", /project_instructions_import_cycle:/);
});

test("a missing import is reported and leaves a placeholder", () => {
  const result = expand("@./gone.md");
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? "", /^project_instructions_import_missing:/);
  assert.match(result.text, /import not readable/);
});

test("an import outside the workspace is refused, home paths included", () => {
  const outside = path.join(path.dirname(workspace), "outside-import.md");

  writeFileSync(outside, "host bytes");
  const result = expand(`@${outside.replaceAll("\\", "/")}`);

  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? "", /^project_instructions_import_outside_root:/);
  assert.match(result.text, /outside the workspace/);
  assert.doesNotMatch(result.text, /host bytes/);
});

test("a tilde import is a containment refusal, not a home read", () => {
  const result = expand("@~/credentials.md");
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? "", /^project_instructions_import_outside_root:/);
});

test("inline @mentions are left alone; only whole-line references import", () => {
  write("not-an-import.md", "should not appear");
  const text = "see @./not-an-import.md inline";
  const result = expand(text);
  assert.equal(result.text, text);
});

test("expansion depth is bounded", () => {
  for (let i = 0; i < 10; i += 1) {
    write(`d${i}.md`, `L${i}\n@./d${i + 1}.md`);
  }
  const result = expand("@./d0.md");
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? "", /project_instructions_import_depth:/);
});

test("the budget is shared across the whole expansion, and spent in bytes", () => {
  // Two sibling imports of 30 bytes each against a 50-byte budget: the first
  // spends it down, the second is refused — a per-branch copy of the budget
  // would have admitted both (复核 F4).
  write("budget-a.md", "a".repeat(30));
  write("budget-b.md", "b".repeat(30));
  const result = expand("@./budget-a.md\nmiddle\n@./budget-b.md", workspace, 50);

  assert.match(result.text, /^a{30}\nmiddle\n/);
  assert.doesNotMatch(result.text, /b{30}/);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? "", /^project_instructions_import_budget:/);
});

test("a nested chain cannot spend the budget twice", () => {
  // Outer file: 50 bytes of body + 17 bytes of import line = 67; a 100-byte
  // budget leaves 33 for the nested 40-byte import, which must be refused —
  // a per-branch copy of the budget would have admitted it (复核 F4).
  write("nest-outer.md", `${"o".repeat(50)}\n@./nest-inner.md`);
  write("nest-inner.md", "i".repeat(40));
  const result = expand("@./nest-outer.md", workspace, 100);

  assert.match(result.text, /o{50}/);
  assert.doesNotMatch(result.text, /i{40}/);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? "", /^project_instructions_import_budget:/);
});
