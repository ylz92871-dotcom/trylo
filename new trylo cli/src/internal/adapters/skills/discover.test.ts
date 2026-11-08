import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverSkills, type SkillReader } from "./discover.js";

/**
 * Layered skill discovery (WP14.1 / C51/C52).
 *
 * The order the caller passes is the precedence: earlier roots win. Both
 * duplicate shapes must be explainable, not silent — the same file reached
 * twice, and the same name claimed by two different files.
 */

function fakeReader(files: Record<string, string>, dirs: string[]): SkillReader {
  const canonical = new Map<string, string>();
  return {
    listDirectories(root) {
      return dirs.filter((dir) => dir.startsWith(root + "/")).map((dir) => dir.split("/").pop() ?? dir);
    },
    readText(absolutePath) {
      return files[absolutePath.replaceAll("\\", "/")];
    },
    canonical(absolutePath) {
      const key = absolutePath.replaceAll("\\", "/");
      return canonical.get(key) ?? key;
    },
  };
}

const ROOT_A = "/ws/.trylo/skills";
const ROOT_B = "/home/u/.trylo/skills";

function skill(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\nbody of ${name}`;
}

test("discovers directory-format skills from every root, precedence order first", () => {
  const found = discoverSkills(
    [
      { source: "project", directory: ROOT_A },
      { source: "user", directory: ROOT_B },
    ],
    fakeReader(
      { [`${ROOT_A}/alpha/SKILL.md`]: skill("alpha"), [`${ROOT_B}/beta/SKILL.md`]: skill("beta") },
      [`${ROOT_A}/alpha`, `${ROOT_B}/beta`],
    ),
  );

  assert.equal(found.problems.length, 0);
  assert.deepEqual(found.skills.map((s) => s.name), ["alpha", "beta"]);
  assert.deepEqual(found.skills.map((s) => s.source), ["project", "user"]);
});

test("the frontmatter name overrides the directory name", () => {
  const found = discoverSkills(
    [{ source: "user", directory: ROOT_B }],
    fakeReader({ [`${ROOT_B}/dir-name/SKILL.md`]: skill("front-name") }, [`${ROOT_B}/dir-name`]),
  );

  assert.equal(found.skills[0]?.name, "front-name");
  // The root is reported the way the platform spells paths; the catalog
  // normalises to forward slashes only when composing the model-facing header.
  assert.equal(found.skills[0]?.skillRoot.replaceAll("\\", "/"), `${ROOT_B}/dir-name`);
});

test("a broken SKILL.md is a problem, not a silently missing skill", () => {
  const found = discoverSkills(
    [{ source: "project", directory: ROOT_A }],
    fakeReader({ [`${ROOT_A}/broken/SKILL.md`]: "---\ndescription broken\n---\nbody" }, [`${ROOT_A}/broken`]),
  );

  assert.equal(found.skills.length, 0);
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0] ?? "", /^skill_invalid:.+:parse/);
});

test("the same file through two roots is loaded once", () => {
  const reader = fakeReader(
    { [`${ROOT_A}/shared/SKILL.md`]: skill("shared"), [`${ROOT_B}/shared/SKILL.md`]: skill("shared") },
    [`${ROOT_A}/shared`, `${ROOT_B}/shared`],
  );

  reader.canonical = (p) => (p.replaceAll("\\", "/").includes("/shared/SKILL.md") ? `${ROOT_A}/shared/SKILL.md` : p);
  const found = discoverSkills(
    [
      { source: "project", directory: ROOT_A },
      { source: "user", directory: ROOT_B },
    ],
    reader,
  );

  assert.equal(found.skills.length, 1);
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0] ?? "", /^skill_duplicate_file:/);
});

test("the same name from two files shadows the lower root, visibly", () => {
  const found = discoverSkills(
    [
      { source: "project", directory: ROOT_A },
      { source: "user", directory: ROOT_B },
    ],
    fakeReader(
      { [`${ROOT_A}/dup/SKILL.md`]: skill("dup"), [`${ROOT_B}/dup/SKILL.md`]: skill("dup") },
      [`${ROOT_A}/dup`, `${ROOT_B}/dup`],
    ),
  );

  assert.equal(found.skills.length, 1);
  assert.equal(found.skills[0]?.source, "project");
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0] ?? "", /^skill_name_shadowed:dup:/);
});

test("a directory without SKILL.md is not a skill and not a problem", () => {
  const found = discoverSkills(
    [{ source: "user", directory: ROOT_B }],
    fakeReader({}, [`${ROOT_B}/empty`]),
  );
  assert.equal(found.skills.length, 0);
  assert.equal(found.problems.length, 0);
});

test("a SKILL.md that exists but cannot be read is a problem, not silence", () => {
  const reader = fakeReader({ [`${ROOT_A}/locked/SKILL.md`]: "never returned" }, [`${ROOT_A}/locked`]);

  reader.readText = (absolutePath) => {
    if (absolutePath.replaceAll("\\", "/").endsWith("/locked/SKILL.md")) {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
    return undefined;
  };
  const found = discoverSkills([{ source: "project", directory: ROOT_A }], reader);

  assert.equal(found.skills.length, 0);
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0] ?? "", /^skill_unreadable:/);
});
