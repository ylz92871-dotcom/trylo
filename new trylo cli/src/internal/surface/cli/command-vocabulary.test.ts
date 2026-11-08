import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "./args.js";
import { completionScript } from "./completion.js";
import { USAGE } from "./usage.js";
import { COMMAND_WORDS, FAMILY_SUBCOMMANDS, ROOT_COMMAND_WORDS } from "./command-vocabulary.js";

/**
 * The vocabulary must match what the router and the completion scripts actually
 * answer to.
 *
 * ## What each case catches
 *
 * The family table is keyed by `FamilyWord`, so a word with no runner is a
 * compile error and needs no test. What *can* drift silently is the other
 * direction: `args.ts` claiming a verb this list forgot, or a shell script
 * carrying its own copy of the list. Both happened — `TOP_LEVEL` in
 * `completion.ts` was missing `checkpoint`, `queue`, `diff`, `review`,
 * `providers`, `schedule` and `daemon` while all seven parsed and ran fine.
 * A verb that works but never completes is a verb nobody finds.
 */

test("every root word in the vocabulary is a verb the root parser claims", () => {
  for (const word of ROOT_COMMAND_WORDS) {
    const parsed = parseArgs([word]);
    if (parsed.kind === "error") {
      // A usage error about a missing subcommand ("queue requires a subcommand")
      // is the parser claiming the verb. Saying `unknown command: queue` is not.
      assert.ok(
        !parsed.message.includes(`unknown command: ${word}`),
        `the root does not know "${word}" that the vocabulary advertises: ${parsed.message}`,
      );
    }
  }
});

test("the completion scripts offer every word in the vocabulary", () => {
  for (const shell of ["bash", "zsh", "fish"] as const) {
    const script = completionScript(shell);
    for (const word of COMMAND_WORDS) {
      assert.ok(
        script.includes(word),
        `${shell} completion is missing "${word}" — the vocabulary and the script drifted`,
      );
    }
  }
});

test("the root's own help names every word in the vocabulary", () => {
  // The families used to be appended at dispatch time, which meant `trylo --help`
  // was assembled from two places. They are written in `usage.ts` now, and this is
  // what keeps that single list honest when a verb is added.
  const help = USAGE;
  for (const word of COMMAND_WORDS) {
    assert.match(help, new RegExp(`trylo ${escapeForRegExp(word)}`), `USAGE does not mention ${word}`);
  }
});

test("every family's sub-verbs complete in all three shells", () => {
  // Top-level words completing is not enough: `trylo bg <TAB>` used to offer
  // nothing at all, because only `session` had a sub-verb list. The sub-verbs now
  // come from `FAMILY_SUBCOMMANDS`, which is keyed by `FamilyWord` — so a family
  // added without its sub-verbs is a compile error, and a shell script that stops
  // rendering them fails here.
  for (const [word, verbs] of Object.entries(FAMILY_SUBCOMMANDS)) {
    for (const shell of ["bash", "zsh", "fish"] as const) {
      const lines = completionScript(shell)
        .split("\n")
        .filter((line) => line.includes(`${word})`) || line.includes(`subcommand_from ${word}`));

      assert.ok(lines.length > 0, `${shell} has no sub-command completion for ${word}`);
      const body = lines.join("\n");

      for (const verb of verbs) {
        assert.match(
          body,
          new RegExp(`\\b${escapeForRegExp(verb)}\\b`),
          `${shell} completion is missing \`${word} ${verb}\``,
        );
      }
    }
  }
});

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
