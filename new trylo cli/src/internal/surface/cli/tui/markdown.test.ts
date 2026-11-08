import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownLines } from "./markdown.js";
import { displayWidth } from "./frame.js";

/**
 * WP23.1 (L43): the model's markdown answer becomes the lines a person reads.
 *
 * The contract is tone-based, not ANSI-based: the parser says *what* a line is
 * (heading, list item, code, table row) and the theme decides how it looks.
 * Width arithmetic uses the same `displayWidth` the frame wraps with, so a
 * table aligned here is a table aligned on a CJK terminal.
 */

test("a heading becomes one strong line with the markers removed", () => {
  assert.deepEqual(markdownLines("# Title", 80), [{ tone: "strong", text: "Title" }]);
});

test("heading depth keeps the text and drops the hashes", () => {
  assert.deepEqual(markdownLines("### Section", 80), [{ tone: "strong", text: "Section" }]);
});

test("bullet list keeps its markers as the person wrote them", () => {
  assert.deepEqual(markdownLines("- first\n- second", 80), [
    { tone: "assistant", text: "- first" },
    { tone: "assistant", text: "- second" },
  ]);
});

test("ordered list keeps the numbers as written", () => {
  assert.deepEqual(markdownLines("1. one\n2. two", 80), [
    { tone: "assistant", text: "1. one" },
    { tone: "assistant", text: "2. two" },
  ]);
});

test("a nested list indents by two spaces per level", () => {
  assert.deepEqual(markdownLines("- top\n  - under", 80), [
    { tone: "assistant", text: "- top" },
    { tone: "assistant", text: "  - under" },
  ]);
});

test("a fenced code block renders its fence and body as output lines", () => {
  assert.deepEqual(markdownLines("```ts\nconst a = 1;\n```", 80), [
    { tone: "output", text: "```ts" },
    { tone: "output", text: "const a = 1;" },
    { tone: "output", text: "```" },
  ]);
});

test("a blockquote is marked in the text and dimmed by tone", () => {
  assert.deepEqual(markdownLines("> said", 80), [{ tone: "quote", text: "▌ said" }]);
});

test("a horizontal rule becomes a rule", () => {
  assert.deepEqual(markdownLines("---", 80), [{ tone: "output", text: "───" }]);
});

test("inline emphasis markers are stripped from the text", () => {
  assert.deepEqual(markdownLines("a **bold** and *soft* and `code` word", 80), [
    { tone: "assistant", text: "a bold and soft and code word" },
  ]);
});

test("plain text without any markdown is the same lines as before", () => {
  assert.deepEqual(markdownLines("just text\nsecond line", 80), [
    { tone: "assistant", text: "just text" },
    { tone: "assistant", text: "second line" },
  ]);
});

test("a table renders header, rule and rows aligned by display width", () => {
  const lines = markdownLines("| A | B |\n| --- | --- |\n| one | 2 |", 80);
  assert.equal(lines.length, 3);
  const widths = lines.map((line) => displayWidth(line.text));
  assert.equal(new Set(widths).size, 1, `rows misaligned: ${lines.map(l => l.text).join(" / ")}`);
  assert.match(lines[0]?.text ?? "", /A/);
  assert.match(lines[2]?.text ?? "", /one/);
});

test("a CJK table aligns columns by terminal columns, not code units", () => {
  const lines = markdownLines("| 名前 | 値 |\n| --- | --- |\n| 中文很长 | x |", 80);
  const widths = lines.map((line) => displayWidth(line.text));

  assert.equal(new Set(widths).size, 1, `rows misaligned: ${lines.map(l => l.text).join(" / ")}`);

  // Every row must still fit the terminal the table was laid out for.
  for (const width of widths) {
    assert.ok(width <= 80, `row is ${width} columns wide`);
  }
});

test("a table wider than the terminal shrinks to fit it", () => {
  const header = "| alpha | beta | gamma | delta |";
  const rows = "| 1 | 2 | 3 | 4 |";
  const source = `${header}\n| --- | --- | --- | --- |\n${rows}`;
  const lines = markdownLines(source, 24);

  for (const line of lines) {
    assert.ok(displayWidth(line.text) <= 24, `row overflows: ${line.text}`);
  }
});

test("a vertical bar outside a table is not a table", () => {
  assert.deepEqual(markdownLines("a | b is just text", 80), [
    { tone: "assistant", text: "a | b is just text" },
  ]);
});

test("table alignment honoured: a right-aligned column pads on the left", () => {
  const lines = markdownLines("| A |\n| ---: |\n| x |", 80);
  const row = lines[2]?.text ?? "";
  assert.match(row, /x │$/, `right-aligned cell should sit next to its right border: ${row}`);
});
