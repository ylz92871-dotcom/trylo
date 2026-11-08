import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkillDocument } from "./parse.js";

/**
 * SKILL.md parsing and validation (WP14.1 / C51).
 *
 * The parser is the trust boundary for files written by anyone who can write a
 * directory: a broken file must come back as an explainable `invalid`, never as
 * a half-parsed skill whose fields quietly mean something else.
 */

test("parses a frontmatter skill with explicit fields", () => {
  const parsed = parseSkillDocument(
    [
      "---",
      "name: commit-helper",
      "description: Drafts commits from the staged diff",
      "when_to_use: When the user asks to commit",
      "argument-hint: [style]",
      "allowed-tools: read_file, run_shell",
      "context: fork",
      "---",
      "",
      "Write the commit message.",
    ].join("\n"),
  );

  assert.equal(parsed.kind, "ok");

  if (parsed.kind !== "ok") return;

  assert.equal(parsed.skill.name, "commit-helper");
  assert.equal(parsed.skill.description, "Drafts commits from the staged diff");
  assert.equal(parsed.skill.whenToUse, "When the user asks to commit");
  assert.equal(parsed.skill.argumentHint, "[style]");
  assert.deepEqual([...parsed.skill.allowedTools], ["read_file", "run_shell"]);
  assert.equal(parsed.skill.forkExecution, true);
  assert.equal(parsed.skill.userInvocable, true);
  assert.equal(parsed.skill.disableModelInvocation, false);
  assert.equal(parsed.skill.body, "Write the commit message.");
});

test("absent frontmatter falls back to a body-derived description", () => {
  const parsed = parseSkillDocument("# Deploy\n\nShip the build to staging.");
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.equal(parsed.skill.name, undefined);
  assert.equal(parsed.skill.description, "# Deploy");
  assert.equal(parsed.skill.body, "# Deploy\n\nShip the build to staging.");
});

test("frontmatter name overrides the directory name and collapses whitespace", () => {
  const parsed = parseSkillDocument("---\nname:   multi  word  \ndescription: d\n---\nbody");
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.equal(parsed.skill.name, "multi word");
});

test("a name over the 64-character cap is invalid, not truncated", () => {
  const parsed = parseSkillDocument(`---\nname: ${"x".repeat(65)}\ndescription: d\n---\nbody`);
  assert.equal(parsed.kind, "invalid");
});

test("boolean frontmatter only accepts true or the string true", () => {
  for (const [raw, expected] of [
    ["user-invocable: false", false],
    ["user-invocable: true", true],
    ["disable-model-invocation: true", true],
    ["disable-model-invocation: 'true'", true],
  ] as const) {
    const parsed = parseSkillDocument(`---\n${raw}\ndescription: d\n---\nbody`);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") continue;
    if (raw.startsWith("user-invocable")) assert.equal(parsed.skill.userInvocable, expected);
    else assert.equal(parsed.skill.disableModelInvocation, expected);
  }
});

test("an unrecognised boolean spelling is invalid, never a silent permissive default", () => {
  // 复核 F7: `1` (or TRUE/yes) must not quietly mean "model may invoke".
  for (const field of ["user-invocable", "disable-model-invocation"]) {
    const parsed = parseSkillDocument(`---\n${field}: 1\ndescription: d\n---\nbody`);
    assert.equal(parsed.kind, "invalid");
    if (parsed.kind !== "invalid") continue;
    assert.match(parsed.reason, new RegExp(`unrecognized boolean '${field}`));
  }
});

test("paths frontmatter accepts a YAML list and expands braces", () => {
  const parsed = parseSkillDocument(
    "---\ndescription: d\npaths:\n  - src/*.{ts,tsx}\n  - docs\n---\nbody",
  );
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.deepEqual([...(parsed.skill.paths ?? [])], ["src/*.ts", "src/*.tsx", "docs"]);
});

test("paths as a comma string splits without breaking braces", () => {
  const parsed = parseSkillDocument("---\ndescription: d\npaths: a, b, src/*.{ts,tsx}\n---\nbody");
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.deepEqual([...(parsed.skill.paths ?? [])], ["a", "b", "src/*.ts", "src/*.tsx"]);
});

test("argument names accept a list and drop numeric shorthands", () => {
  const parsed = parseSkillDocument(
    "---\ndescription: d\narguments:\n  - style\n  - 0\n  - scope\n---\nbody",
  );
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.deepEqual([...(parsed.skill.argumentNames ?? [])], ["style", "scope"]);
});

test("unparseable frontmatter is an explainable invalid, never a silent guess", () => {
  const parsed = parseSkillDocument("---\ndescription: [unclosed\n  broken\n---\nbody");
  assert.equal(parsed.kind, "invalid");
  if (parsed.kind !== "invalid") return;
  assert.match(parsed.reason, /frontmatter/);
});

test("context values other than fork are not fork execution", () => {
  const parsed = parseSkillDocument("---\ndescription: d\ncontext: inline\n---\nbody");
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.equal(parsed.skill.forkExecution, false);
});
