import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_INSTRUCTION_BYTES,
  ancestorChain,
  createNodeInstructionReader,
  lookupInstruction,
  type InstructionReader,
} from "./instruction-reader.js";
import { assembleInstructionMessages, loadInstructionMessages, lookupLocalInstructions } from "./assemble.js";

/**
 * WP-CLI-B1 §3.1, against real files in a real temp tree.
 *
 * The behaviours worth pinning are the ones a user would call a bug: two
 * rule files in one directory must not both be adopted, a rule found in a
 * subdirectory must not be attributed to the root, a file that exists but is
 * too large must be reported rather than silently shortened, and a project with
 * no rules must produce no rule messages at all.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-b1a-"));
}

const environment = {
  platform: "win32",
  nodeVersion: "v22.22.2",
} as const;

test("environment guidance follows the configured shell instead of denying interpreter support", () => {
  const messages = assembleInstructionMessages([], { ...environment, workspaceRoot: "/workspace" });
  const text = messages.map(message => message.content).join("\n");
  assert.match(text, /configured shell/);
  assert.match(text, /tool's description and argument schema/);
  assert.doesNotMatch(text, /not through Bash or PowerShell|redirections remain unsupported/);
});

test("default instructions ask for public progress on tool work and respect results-only requests", () => {
  const text = assembleInstructionMessages([], { ...environment, workspaceRoot: "/workspace" })
    .map(message => message.content).join("\n");
  assert.match(text, /brief user-facing progress update before/);
  assert.match(text, /user asks for results only/);
  assert.match(text, /do not expose private chain-of-thought/);
});

function load(root: string, startup: string) {
  return loadInstructionMessages({
    reader: createNodeInstructionReader(),
    workspaceRoot: root,
    startupDirectory: startup,
    environment: { ...environment, workspaceRoot: root, startupDirectory: startup },
  });
}

test("the root rule file is adopted and named in the message it produces", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "AGENTS.md"), "run npm test before finishing");
    const result = load(root, root);

    assert.equal(result.adopted.length, 1);
    const adopted = result.adopted[0];

    assert.ok(adopted);
    assert.equal(adopted.relativePath, "AGENTS.md");
    assert.equal(adopted.scope, "workspace_root");
    assert.equal(adopted.contentHash.length, 16);
    assert.match(
      result.messages.map((message) => message.content).join("\n"),
      /run npm test before finishing/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one directory contributes one rule file: AGENTS.md wins, the others are not read", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "AGENTS.md"), "from agents");
    writeFileSync(join(root, "CLAUDE.md"), "from claude");
    writeFileSync(join(root, "GEMINI.md"), "from gemini");
    const result = load(root, root);

    assert.equal(result.adopted.length, 1);
    assert.equal(result.adopted[0]?.relativePath, "AGENTS.md");
    const text = result.messages.map((message) => message.content).join("\n");

    assert.match(text, /from agents/);
    assert.doesNotMatch(text, /from claude/);
    assert.doesNotMatch(text, /from gemini/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLAUDE.md is used only where AGENTS.md is absent, and GEMINI.md only after that", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "CLAUDE.md"), "from claude");
    writeFileSync(join(root, "GEMINI.md"), "from gemini");
    assert.equal(load(root, root).adopted[0]?.relativePath, "CLAUDE.md");

    writeFileSync(join(root, "AGENTS.md"), "from agents");
    assert.equal(load(root, root).adopted[0]?.relativePath, "AGENTS.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a subdirectory rule is scoped to its own subtree and composed under the root's", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "AGENTS.md"), "root rule");
    mkdirSync(join(root, "src", "ui"), { recursive: true });
    writeFileSync(join(root, "src", "AGENTS.md"), "src rule");
    writeFileSync(join(root, "src", "ui", "AGENTS.md"), "ui rule");

    const result = load(root, join(root, "src", "ui"));

    assert.deepEqual(
      result.adopted.map((rule) => rule.relativePath),
      ["AGENTS.md", "src/AGENTS.md", "src/ui/AGENTS.md"],
    );
    // Root first: a deeper rule refines the one above it, and the order says so.
    assert.equal(result.adopted[0]?.scope, "workspace_root");
    assert.equal(result.adopted[2]?.scope, "directory");
    assert.equal(result.adopted[2]?.scopePath, "src/ui");
    const text = result.messages.map((message) => message.content).join("\n");

    assert.match(text, /applies to src\/ui\/ and below/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("running from a subdirectory still sees the root rules", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "AGENTS.md"), "root rule");
    mkdirSync(join(root, "src"), { recursive: true });
    const result = load(root, join(root, "src"));

    assert.deepEqual(
      result.adopted.map((rule) => rule.relativePath),
      ["AGENTS.md"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run pointed at a subdirectory does not inherit the parent project's rules", () => {
  const outer = tempRoot();
  try {
    writeFileSync(join(outer, "AGENTS.md"), "outer project rule");
    mkdirSync(join(outer, "inner"));
    // `--workspace inner` from the outer directory: the inner project is a
    // different project and the outer rule is not its rule.
    const result = load(join(outer, "inner"), join(outer, "inner"));
    assert.equal(result.adopted.length, 0);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("a project with no rules produces no rule messages, and says so by staying empty", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "package.json"), "{}");
    const result = load(root, root);

    assert.deepEqual(result.adopted, []);
    assert.deepEqual(result.problems, []);
    // The environment statement is unconditional; no rule claims to exist.
    const text = result.messages.map((message) => message.content).join("\n");

    assert.doesNotMatch(text, /Project instructions from/);
    assert.match(text, /workspace root:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rule file over the ceiling is reported, never silently shortened", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "AGENTS.md"), "x".repeat(MAX_INSTRUCTION_BYTES + 1));
    const result = load(root, root);
    assert.equal(result.adopted.length, 0);
    assert.deepEqual(result.problems, ["project_instructions_oversized:AGENTS.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable rule file is reported rather than treated as no rules", () => {
  // A reader that sees the file's size but cannot read it is the "exists but
  // fails" case: reporting "no rules here" would let a real rule set vanish.
  const root = tempRoot();
  const reader: InstructionReader = {
    fileSize: () => 128,
    readText: () => undefined,
  };
  const lookup = lookupInstruction(reader, root, root, "workspace_root");

  assert.equal(lookup.kind, "unreadable");

  const result = loadInstructionMessages({
    reader,
    workspaceRoot: root,
    startupDirectory: root,
    environment: { ...environment, workspaceRoot: root, startupDirectory: root },
  });

  assert.deepEqual(result.problems, ["project_instructions_unreadable:AGENTS.md"]);
  rmSync(root, { recursive: true, force: true });
});

test("the environment statement names the real platform and describes both shell modes", () => {
  const root = tempRoot();
  try {
    const result = load(root, root);
    const text = result.messages[0]?.content ?? "";

    assert.match(text, /platform: win32/);
    assert.match(text, /node: v22\.22\.2/);
    assert.match(text, /configured shell/);
    assert.match(text, /direct execution/);
    assert.match(text, /planner-approved pipelines and sequential commands/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rules are labelled as the project's own, not as learned hints", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "AGENTS.md"), "prefer named exports");
    const text = load(root, root)
      .messages.map((message) => message.content)
      .join("\n");

    assert.match(text, /these are this project's own engineering rules/i);
    assert.doesNotMatch(text, /learned historical hints/i);
    assert.doesNotMatch(text, /Trylo learned profile/);
    // The user's current instruction is stated as the override.
    assert.match(text, /follow the user/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the content hash changes when the rule text changes", () => {
  const root = tempRoot();
  try {
    const file = join(root, "AGENTS.md");

    writeFileSync(file, "first version");
    const before = load(root, root).adopted[0]?.contentHash;

    writeFileSync(file, "second version");
    const after = load(root, root).adopted[0]?.contentHash;

    assert.ok(before && after);
    assert.notEqual(before, after, "a resume compares hashes to notice a rule changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ancestor chain stops at the workspace root", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    const chain = ancestorChain(root, join(root, "a", "b"));
    assert.deepEqual(chain, [root, join(root, "a"), join(root, "a", "b")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deep module's rules are found when a target inside it is read", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "AGENTS.md"), "root rule");
    mkdirSync(join(root, "src", "ui"), { recursive: true });
    writeFileSync(join(root, "src", "ui", "AGENTS.md"), "never export a raw button");
    writeFileSync(join(root, "src", "ui", "button.ts"), "export const Button = 1;\n");

    const found = lookupLocalInstructions(
      createNodeInstructionReader(),
      root,
      join(root, "src", "ui", "button.ts"),
    );

    assert.deepEqual(
      found.map((rule) => rule.relativePath),
      ["AGENTS.md", "src/ui/AGENTS.md"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
