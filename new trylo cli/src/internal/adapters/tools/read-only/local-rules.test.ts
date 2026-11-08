import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonObject, JsonValue } from "../../../protocol/envelope.js";
import type { ToolOutcome } from "../../../ports/tools.js";
import type { LocalRuleLookup } from "../../project-instructions/appendix.js";
import {
  createNodeInstructionReader,
  type InstructionReader,
} from "../../project-instructions/instruction-reader.js";
import { buildLocalRuleLookup } from "../../project-instructions/local-lookup.js";
import { createReadOnlyTools } from "./index.js";
import { createNodeFileSystemReader } from "./node-fs.js";

/**
 * `read_file`'s rule appendix (WP-CLI-B1 §3.1).
 *
 * The contract this file holds: rules governing a file are found *because that
 * file is being read*, they arrive as their own labelled section rather than
 * mixed into `content`, and a rule the run was already given is not repeated.
 * The last one matters most in a real repository — a root `AGENTS.md` is already
 * a seed message, and re-sending it on every read would spend the context window
 * restating what the model holds.
 *
 * Real directories, real files, a real disk reader. Only the assertion is the
 * point; a fake would test that the mock returns what the mock returns.
 */

type ReadResult = {
  readonly content: string;
  readonly output: string;
  readonly localRules: ReadonlyArray<JsonObject> | undefined;
  readonly truncated: boolean;
};

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-rules-"));
}

function write(root: string, relative: string, text: string): void {
  const target = join(root, relative);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text, "utf8");
}

function succeeded(outcome: ToolOutcome): asserts outcome is ToolOutcome & {
  readonly outcome: "result";
} {
  assert.equal(outcome.outcome, "result");
}

function sources(value: JsonValue | undefined): ReadonlyArray<JsonObject> | undefined {
  return Array.isArray(value) ? (value as JsonObject[]) : undefined;
}

function resultOf(outcome: ToolOutcome): ReadResult {
  succeeded(outcome);
  return {
    content: String(outcome.value.content),
    output: outcome.output,
    localRules: sources(outcome.value.localRules),
    truncated: outcome.truncated === true,
  };
}

/** One lookup for the turn, exactly as `host.ts` builds it per turn. */
function toolsFor(
  root: string,
  options: { readonly adoptedPaths?: ReadonlyArray<string>; readonly reader?: InstructionReader } = {},
): { readonly tools: ReturnType<typeof createReadOnlyTools>; readonly lookup: LocalRuleLookup } {
  const reader = options.reader ?? createNodeInstructionReader();
  const lookup = buildLocalRuleLookup(
    {
      workspaceRoot: root,
      reader,
      ...(options.adoptedPaths === undefined ? {} : { adoptedPaths: options.adoptedPaths }),
    },
    reader,
  );

  return {
    tools: createReadOnlyTools({
      workspaceRoot: root,
      reader: createNodeFileSystemReader(),
      localRules: lookup,
    }),
    lookup,
  };
}

function call(path: string): { toolCallId: string; name: string; arguments: JsonObject } {
  return { toolCallId: "c1", name: "read_file", arguments: { path } };
}

test("a local rule for the target's directory arrives with its path and scope", async () => {
  const root = tempRoot();
  try {
    write(root, "src/ui/AGENTS.md", "Use the button factory, never a raw element.");
    write(root, "src/ui/button.ts", "export const button = 1;\n");
    const { tools } = toolsFor(root);

    const result = resultOf(
      await tools.execute(call("src/ui/button.ts"), new AbortController().signal),
    );

    assert.match(result.output, /src\/ui\/AGENTS\.md/);
    assert.match(result.output, /never a raw element/);
    assert.match(result.output, /applies to src\/ui\/ and below/);
    assert.equal(result.localRules?.length, 1);
    assert.equal(result.localRules?.[0]?.relativePath, "src/ui/AGENTS.md");
    assert.equal(result.localRules?.[0]?.scopePath, "src/ui");
    assert.equal(result.localRules?.[0]?.scope, "directory");
    // The rule text is for the model, not for the journal.
    assert.equal(result.localRules?.[0]?.text, undefined);
    assert.match(String(result.localRules?.[0]?.contentHash), /^[0-9a-f]{16}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the appendix is its own section, never mixed into content", async () => {
  const root = tempRoot();
  try {
    write(root, "AGENTS.md", "Root rule text.");
    write(root, "src/AGENTS.md", "Nested rule text.");
    write(root, "src/thing.ts", "const a = 1;\nconst b = 2;\n");
    const { tools } = toolsFor(root, { adoptedPaths: ["AGENTS.md"] });

    const result = resultOf(await tools.execute(call("src/thing.ts"), new AbortController().signal));

    // `content` is what `edit_file` matches against. A rule paragraph inside it
    // would be a corruption the model cannot see.
    assert.equal(result.content, "const a = 1;\nconst b = 2;\n");
    assert.doesNotMatch(result.content, /rule text/);
    assert.match(result.output, /\n\n--- project rules for this file/);
    assert.match(result.output, /--- end project rules ---$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rule already in the request is not repeated on every read", async () => {
  const root = tempRoot();
  try {
    write(root, "AGENTS.md", "Root rule text.");
    write(root, "one.ts", "one\n");
    write(root, "two.ts", "two\n");
    // `AGENTS.md` is in this run's seed messages, so the lookup is told so.
    const { tools } = toolsFor(root, { adoptedPaths: ["AGENTS.md"] });

    const first = resultOf(await tools.execute(call("one.ts"), new AbortController().signal));
    const second = resultOf(await tools.execute(call("two.ts"), new AbortController().signal));

    assert.equal(first.localRules, undefined);
    assert.equal(second.localRules, undefined);
    assert.equal(first.output, "one\n");
    assert.equal(second.output, "two\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rule file is read once per turn however many targets need it", async () => {
  const root = tempRoot();
  try {
    write(root, "src/AGENTS.md", "Nested rule.");
    write(root, "src/a.ts", "a\n");
    write(root, "src/b.ts", "b\n");
    const probes: string[] = [];
    const inner = createNodeInstructionReader();
    const counting: InstructionReader = {
      readText(absolutePath) {
        probes.push(absolutePath);
        return inner.readText(absolutePath);
      },
      fileSize(absolutePath) {
        probes.push(absolutePath);
        return inner.fileSize(absolutePath);
      },
    };

    const { tools } = toolsFor(root, { reader: counting });

    await tools.execute(call("src/a.ts"), new AbortController().signal);
    const afterFirst = probes.length;

    // Three more targets through the *same* turn's lookup. The freeze is the
    // claim under test: disk probes must not grow with the number of reads,
    // because a rule file read ten times is ten chances to hand the model two
    // different versions of the same rule.
    for (const path of ["src/a.ts", "src/b.ts", "src/a.ts"]) {
      await tools.execute(call(path), new AbortController().signal);
    }

    assert.equal(
      probes.length,
      afterFirst,
      `three more reads added ${probes.length - afterFirst} disk probes`,
    );
    assert.ok(afterFirst > 0, "the probe counter must actually observe reads");
    assert.deepEqual(
      probes.filter((probe) => probe.endsWith(join("src", "AGENTS.md"))).length,
      2,
      "one stat for the size ceiling plus one read for the text, once each",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rule edited mid-turn does not change under the model mid-answer", async () => {
  const root = tempRoot();
  try {
    write(root, "src/AGENTS.md", "first version");
    write(root, "src/a.ts", "a\n");
    write(root, "src/b.ts", "b\n");
    const { tools } = toolsFor(root);

    const first = resultOf(await tools.execute(call("src/a.ts"), new AbortController().signal));

    write(root, "src/AGENTS.md", "second version");
    const second = resultOf(await tools.execute(call("src/b.ts"), new AbortController().signal));

    assert.match(first.output, /first version/);
    assert.match(second.output, /first version/);
    assert.doesNotMatch(second.output, /second version/);

    // A fresh lookup — the next turn — sees the current file.
    const next = toolsFor(root);
    const after = resultOf(await next.tools.execute(call("src/b.ts"), new AbortController().signal));

    assert.match(after.output, /second version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a target with no rules of its own keeps the exact previous result", async () => {
  const root = tempRoot();
  try {
    write(root, "AGENTS.md", "root only");
    write(root, "deep/nested/file.ts", "x\n");
    const { tools } = toolsFor(root, { adoptedPaths: ["AGENTS.md"] });

    const result = resultOf(
      await tools.execute(call("deep/nested/file.ts"), new AbortController().signal),
    );

    assert.equal(result.output, "x\n");
    assert.equal(result.content, "x\n");
    assert.equal(result.localRules, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rules and code share one budget, and what was dropped is stated", async () => {
  const root = tempRoot();
  try {
    write(root, "src/AGENTS.md", "r".repeat(40_000));
    write(root, "src/big.ts", "c".repeat(60_000));
    const { tools } = toolsFor(root);

    const result = resultOf(await tools.execute(call("src/big.ts"), new AbortController().signal));

    // The rule did not fit whole, so it is shown as far as it goes *and the
    // shortfall is named* — a model told "cut here, read the file for the rest"
    // can act; a model told nothing cannot.
    assert.match(result.output, /rule body cut here: \d+ more characters/);
    // And the loss is reported through the flag the loop already reads, rather
    // than being visible only in prose the model might skim.
    assert.equal(result.truncated, true);
    // One budget, honestly divided: code keeps what the rule did not take, and
    // the total output never exceeds the tool's ceiling.
    assert.ok(result.content.length > 30_000, `code was starved: ${result.content.length}`);
    assert.ok(
      Buffer.byteLength(result.output, "utf8") <= 65_536 + 200,
      `output exceeded the tool ceiling: ${Buffer.byteLength(result.output, "utf8")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rule body cut by the budget never ends in half a character", async () => {
  const root = tempRoot();
  try {
    // Every character is three bytes, so a byte-budget cut lands mid-character
    // unless the cut is done by code point.
    write(root, "src/AGENTS.md", "模".repeat(20_000));
    write(root, "src/a.ts", "a\n");
    const { tools } = toolsFor(root);

    const result = resultOf(await tools.execute(call("src/a.ts"), new AbortController().signal));

    assert.match(result.output, /rule body cut here/);
    // A `U+FFFD` anywhere in the output means a character was cut in half.
    assert.equal(result.output.includes("�"), false, "a character was split");
    // The whole output must round-trip: decode it and count what a correct cut
    // leaves, which is a whole number of three-byte characters.
    const kept = /content [0-9a-f]{16}\):\n\n([\s\S]*?)\n\[rule body cut here/.exec(result.output);

    assert.ok(kept !== null, "the appendix must carry a body and a cut notice");
    assert.equal(Buffer.byteLength(kept[1] ?? "", "utf8") % 3, 0);
    assert.doesNotMatch(kept[1] ?? "", /�/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
