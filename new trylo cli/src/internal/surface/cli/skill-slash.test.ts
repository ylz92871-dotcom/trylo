import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { expandSkillSlash } from "./skill-slash.js";

/**
 * `/skill-name args` in the REPL (WP14 / L52, user-invocable half).
 *
 * Proven against a real temporary directory, because the point is that a skill
 * written to disk is found, loaded and expanded — a fake reader would only prove
 * that a fake works. The unknown-token contract is also pinned: an input that
 * looks like a slash command but names no skill must still be "unknown", never
 * forwarded as a prompt.
 */

let workspace = "";
let home = "";

before(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "trylo-skill-ws-"));
  home = mkdtempSync(path.join(tmpdir(), "trylo-skill-home-"));
  const projectSkill = path.join(workspace, ".trylo", "skills", "greet");

  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(
    path.join(projectSkill, "SKILL.md"),
    "---\ndescription: greets someone\n---\nGreet $ARGUMENTS warmly.",
  );
  const userSkill = path.join(home, ".trylo", "skills", "home-skill");

  mkdirSync(userSkill, { recursive: true });
  writeFileSync(path.join(userSkill, "SKILL.md"), "---\ndescription: home skill\n---\nHome body.");
  // `disable-model-invocation` 的唯一用途是"只许用户触发"：用户 slash 必须调得动。
  const lockedSkill = path.join(workspace, ".trylo", "skills", "locked");

  mkdirSync(lockedSkill, { recursive: true });
  writeFileSync(
    path.join(lockedSkill, "SKILL.md"),
    "---\ndescription: user-only skill\ndisable-model-invocation: true\n---\nLocked body.",
  );
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("a user-invocable project skill expands with its arguments", () => {
  const expanded = expandSkillSlash("/greet the team", workspace, home, {});
  assert.notEqual(expanded, undefined);
  if (expanded === undefined) return;
  assert.equal(expanded.name, "greet");
  assert.match(expanded.text, /Greet the team warmly\./);
  assert.match(expanded.text, /Base directory for this skill:/);
});

test("a user-layer skill is reachable when the project layer has no such name", () => {
  const expanded = expandSkillSlash("/home-skill", workspace, home, {});
  assert.notEqual(expanded, undefined);
  if (expanded === undefined) return;
  assert.equal(expanded.name, "home-skill");
});

test("an unknown slash token is not a skill and stays unknown", () => {
  assert.equal(expandSkillSlash("/no-such-skill", workspace, home, {}), undefined);
});

test("a prompt that merely starts with a word is not a slash invocation", () => {
  assert.equal(expandSkillSlash("greet the team", workspace, home, {}), undefined);
});

test("the project layer shadows the user layer for the same name", () => {
  const shadowed = path.join(workspace, ".trylo", "skills", "home-skill");

  mkdirSync(shadowed, { recursive: true });
  writeFileSync(path.join(shadowed, "SKILL.md"), "---\ndescription: project twin\n---\nProject body.");
  const expanded = expandSkillSlash("/home-skill", workspace, home, {});

  assert.notEqual(expanded, undefined);

  if (expanded === undefined) return;

  assert.match(expanded.text, /Project body\./);
});

test("disable-model-invocation limits the model, not the user's slash", () => {
  const expanded = expandSkillSlash("/locked", workspace, home, {});
  assert.notEqual(expanded, undefined);
  if (expanded === undefined) return;
  assert.equal(expanded.name, "locked");
  assert.match(expanded.text, /Locked body\./);
});
