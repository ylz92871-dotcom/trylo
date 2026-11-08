import assert from "node:assert/strict";
import { test } from "node:test";
import {
  descriptionFromMarkdown,
  findOutputStyle,
  isStyleName,
  loadOutputStyles,
  parseStyleFile,
  type StyleIo,
} from "./output-styles.js";

/**
 * Output-style loader regression (WP24.2 / L48).
 *
 * The contract under test: a markdown file with frontmatter becomes a
 * named prompt; project beats user; `default` can never be shadowed; a
 * style that is not there reads as absent, never as empty.
 */

function io(files: Readonly<Record<string, string>>): StyleIo {
  return {
    readDir: (dir) =>
      Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`) && path.slice(dir.length + 1).indexOf("/") < 0)
        .map((path) => ({ name: path.slice(dir.length + 1) })),
    readFile: (path) => files[path],
  };
}

const DIRS = { projectDir: "/ws/.trylo/output-styles", userDir: "/home/.trylo/output-styles" };

test("a style file with frontmatter parses name, description and prompt", () => {
  const parsed = parseStyleFile(
    "/ws/.trylo/output-styles/terse.md",
    "---\nname: terse\ndescription: Short answers\nkeep-coding-instructions: true\n---\n\nAnswer briefly.\n",
    "project",
  );

  assert.equal(parsed?.name, "terse");
  assert.equal(parsed?.description, "Short answers");
  assert.equal(parsed?.prompt, "Answer briefly.");
  assert.equal(parsed?.keepCodingInstructions, true);
  assert.equal(parsed?.source, "project");
});

test("missing description falls back to the first markdown line, like the old loader", () => {
  const parsed = parseStyleFile("/ws/.trylo/output-styles/x.md", "# Be terse\n\nAnswer briefly.\n", "user");
  assert.equal(parsed?.name, "x");
  assert.equal(parsed?.description, "Be terse");
});

test("an empty body is not a style, and an unknown key is inert", () => {
  assert.equal(parseStyleFile("/ws/a.md", "---\ndescription: x\n---\n   \n", "project"), undefined);
  const parsed = parseStyleFile("/ws/b.md", "---\nforce-for-plugin: true\n---\nDo it.\n", "project");
  assert.equal(parsed?.prompt, "Do it.");
  assert.equal(parsed?.keepCodingInstructions, undefined);
});

test("project beats user, default cannot be shadowed, and lookup is exact", () => {
  const files: Record<string, string> = {
    "/ws/.trylo/output-styles/terse.md": "Project terse.\n",
    "/home/.trylo/output-styles/terse.md": "User terse.\n",
    "/home/.trylo/output-styles/default.md": "Shadow attempt.\n",
  };
  const styles = loadOutputStyles(io(files), DIRS);

  assert.deepEqual(styles.map((style) => style.name), ["terse"]);
  assert.equal(styles[0]?.prompt, "Project terse.");
  assert.equal(styles[0]?.source, "project");
  assert.equal(findOutputStyle(styles, "terse")?.prompt, "Project terse.");
  assert.equal(findOutputStyle(styles, "missing"), undefined);
});

test("style names are filename-safe, so a lookup can never escape the directory", () => {
  assert.equal(isStyleName("terse-2_v3"), true);
  assert.equal(isStyleName("../escape"), false);
  assert.equal(isStyleName("has space"), false);
  assert.equal(isStyleName(""), false);
  assert.equal(descriptionFromMarkdown("", "fallback"), "fallback");
});
