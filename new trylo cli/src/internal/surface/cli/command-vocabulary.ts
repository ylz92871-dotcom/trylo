/**
 * The vocabulary of top-level commands — the one place that says what a person
 * may type after `trylo`.
 *
 * ## Why a list, when `args.ts` already decides this
 *
 * `args.ts` answers *how* a verb is parsed; this answers *which verbs exist*.
 * They were the same knowledge in three hand-written copies (`usage.ts`'s
 * `USAGE`, `usage.ts`'s `HELP_FAMILIES`, `completion.ts`'s `TOP_LEVEL`) plus a
 * fourth in the command-family table, and the copies had already drifted: the
 * completion list was missing `checkpoint`, `queue`, `diff`, `review`,
 * `providers`, `schedule` and `daemon`. A verb that parses fine and completes
 * fine but is absent from the tab-completion list is a verb nobody finds.
 *
 * `command-vocabulary.test.ts` is what keeps this honest rather than intent: it
 * drives the real router over every word here and fails on any word the router
 * does not claim. A new verb therefore needs a line in this file *and* a parser
 * that answers it — one of the two is not enough.
 *
 * ## Why the family words are `as const`
 *
 * The family table is keyed by these words, so adding a word here without
 * teaching the table how to answer it is a compile error, not a runtime
 * surprise. That is the same shape `clap`'s `enum Subcommand` gives Rust
 * command trees: the registry is checked for coverage by the type system.
 */

/** The verbs the root's own dispatcher parses (see `args.ts`). */
export const ROOT_COMMAND_WORDS: ReadonlyArray<string> = [
  "run",
  "exec",
  "login",
  "logout",
  "status",
  "auth",
  "mcp",
  "doctor",
  "update",
  "config",
  "session",
  "queue",
  "checkpoint",
  "diff",
  "review",
  "providers",
  "output-style",
  "memory",
  "workflow",
  "context",
  "completion",
  "version",
  "help",
];

/** The verbs owned by a command family outside the root's parser. */
export const FAMILY_COMMAND_WORDS = ["schedule", "daemon", "bg", "watch", "tools"] as const;

/** One family word: the table must answer every one of them, by type. */
export type FamilyWord = (typeof FAMILY_COMMAND_WORDS)[number];

/**
 * The sub-verbs each family answers to, for shell completion.
 *
 * Keyed by `FamilyWord`, so adding a family verb without spelling out what it
 * accepts is a compile error rather than a silent `trylo bg <TAB>` that offers
 * nothing. This is only the families' side: the root's own sub-verbs still live in
 * `completion.ts` with their owners, and moving those here is a separate change.
 */
export const FAMILY_SUBCOMMANDS: Record<FamilyWord, ReadonlyArray<string>> = {
  tools: ["search", "evolve", "candidates", "trial", "trials", "improve", "use", "uses", "withdraw"],
  schedule: ["add", "list", "remove", "run"],
  daemon: ["status", "start", "stop"],
  bg: ["ps", "logs", "attach", "kill"],
  watch: ["add", "list", "cancel", "check", "forget"],
};

/** Everything a person may type as the first word. */
export const COMMAND_WORDS: ReadonlyArray<string> = [
  ...ROOT_COMMAND_WORDS,
  ...FAMILY_COMMAND_WORDS,
];
