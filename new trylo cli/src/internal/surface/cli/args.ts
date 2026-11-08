import {
  parseAuthAdd,
  parseAuthDelete,
  parseAuthList,
  parseAuthStatus,
  parseAuthSwitch,
  parseLogin,
  parseLogout,
} from "./args-auth.js";
import { parseDoctor } from "./args-doctor.js";
import { parseMcp } from "./args-mcp.js";
import { parseCheckpoint } from "./args-checkpoint.js";
import { parseDiff, parseReview } from "./args-review.js";
import { parseProviders } from "./args-providers.js";
import { parseMemory } from "./args-memory.js";
import { parseSession } from "./args-session.js";
import { parseQueue } from "./args-queue.js";
import { parseCompletion } from "./completion.js";
import { parseRun } from "./args-run.js";
import { parseInteractiveLearning } from "./args-interactive.js";
import { parseUpdate } from "./args-update.js";
import { parseOutputStyle } from "./args-output-style.js";
import { parseWorkflow } from "./args-workflow.js";
import { parseContext } from "./args-context.js";
import { parseLearn } from "./args-learn.js";
import { parseLibrary } from "./args-library.js";
import {
  flagToken,
  parseSimple,
  readLearning,
  usageError,
} from "./args-tokens.js";
import {
  type LearningSwitch,
  type ParsedCommand,
} from "./args-primitives.js";
import { familyHelpCommand } from "./usage.js";
import { FAMILY_COMMAND_WORDS } from "./command-vocabulary.js";

/**
 * CLI argument parsing.
 *
 * Pure: no IO, no process access, no defaults read from the environment. The
 * parsed result is the only thing the command layer is allowed to act on, so a
 * malformed invocation can never half-execute.
 *
 * This file is the dispatcher plus the public re-exports. The vocabulary and the
 * parsed-command shapes live in `args-primitives.ts`, and each command family
 * parses itself: `args-run.ts` for `run`, `args-auth.ts` for the credential
 * commands (`login`, `logout`, `status`, `auth list`, `auth switch`). A new
 * family is a new file plus one branch here — never a longer `if` chain in a
 * shared file.
 */

export {
  usageError,
} from "./args-tokens.js";

export {
  CREDENTIAL_PROVIDER_IDS,
  COMPACT_SUMMARY_MODES,
  OUTPUT_FORMATS,
  PROVIDER_IDS,
  isCompactSummaryMode,
  isCredentialProviderId,
  isOutputFormat,
  isProviderId,
  type AuthScopeOptions,
  type AuthDeleteOptions,
  type AuthSwitchOptions,
  type CompactSummaryMode,
  type CompletionShell,
  type CredentialProviderId,
  type LoginCommandOptions,
  type LogoutCommandOptions,
  type McpAddCommandOptions,
  type McpTargetOptions,
  type DiffCommandOptions,
  type ReviewCommandOptions,
  type UpdateOptions,
  type OutputStyleListOptions,
  type OutputStyleShowOptions,
  type WorkflowListOptions,
  type WorkflowShowOptions,
  type WorkflowRunOptions,
  type ContextOptions,
  type CheckpointListOptions,
  type CheckpointRestoreOptions,
  type CheckpointDiffOptions,
  type QueueAddOptions,
  type QueueListOptions,
  type QueueDropOptions,
  type SessionReconcileOptions,
  type SessionReviewOptions,
  type SessionForkOptions,
  type SessionRenameOptions,
  type SessionExportOptions,
  type SessionArchiveOptions,
  type SessionTargetOptions,
  type ProvidersConfigOptions,
  type ProvidersListOptions,
  type ProvidersModelsOptions,
  type ProvidersSwitchOptions,
  type LearningSwitch,
  type OutputFormat,
  type ParsedCommand,
  type ProviderId,
  type ResolvedRequestOptions,
  type RunCommandOptions,
} from "./args-primitives.js";

/**
 * The flags `trylo` accepts *before* the command word.
 *
 * Only the learning switch lives here, and it stays alone on purpose: with two
 * global flags, "which command did I mean" would start depending on the order
 * they were typed in.
 */
const GLOBAL_FLAGS: ReadonlyArray<string> = ["learning"];

type Prelude = {
  readonly learning?: LearningSwitch;
  readonly rest: ReadonlyArray<string>;
};

/**
 * Consumes the global flags, and stops at the first token it does not own.
 *
 * It deliberately does not try to know the whole vocabulary: `--help` is a
 * command-shaped word this file already handles, and a bare `trylo` is the
 * REPL — so an unknown `--flag` falls through to the ordinary dispatcher and is
 * reported there, where the message can name the command the user was aiming
 * at.
 */
function takeGlobalFlags(argv: ReadonlyArray<string>): Prelude | ParsedCommand {
  let learning: LearningSwitch | undefined;
  let index = 0;

  for (;;) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }

    const parsed = token.startsWith("--") ? flagToken(token) : undefined;
    if (parsed === undefined || !GLOBAL_FLAGS.includes(parsed.name)) {
      break;
    }

    const got = readLearning(argv, index, parsed.inlineValue);
    if (got.error !== undefined) {
      return got.error;
    }

    learning = got.value;
    index = got.next;
  }

  return { ...(learning === undefined ? {} : { learning }), rest: argv.slice(index) };
}

export function parseArgs(argv: ReadonlyArray<string>): ParsedCommand {
  const prelude = takeGlobalFlags(argv);
  if (!("rest" in prelude)) {
    return prelude;
  }

  const { learning, rest } = prelude;
  const first = rest[0];
  if (first === undefined) {
    return { kind: "repl", ...(learning === undefined ? {} : { learning }) };
  }

  if (first === "--help" || first === "-h" || first === "help") {
    return { kind: "help" };
  }

  if (first === "--version" || first === "-v" || first === "version") {
    return { kind: "version" };
  }

  // A switch no command here consumes is refused rather than ignored: a flag
  // that looks accepted and does nothing is worse than a usage error.
  if (learning !== undefined && first !== "run" && first !== "exec" && first !== "doctor" && first !== "repl") {
    return usageError(
      `${first} does not accept --learning`,
      "the learning switch belongs to `trylo run`, `trylo doctor`, or a bare `trylo`",
    );
  }

  // `exec` is the headless entry point's Codex spelling (WP24.1/C72): the
  // same run parser, the same options, the same defaults. Codex `exec`
  // subcommands (review/fork) are not separate verbs here — `review` and
  // `session fork` already cover them, and a second spelling of the same
  // operation would be a second source of truth.
  if (first === "run" || first === "exec") {
    return parseRun(rest.slice(1), learning);
  }

  if (first === "repl") return parseInteractiveLearning(rest.slice(1), learning);

  if (first === "update") {
    return parseUpdate(rest.slice(1));
  }

  if (first === "output-style") {
    return parseOutputStyle(rest.slice(1));
  }

  if (first === "workflow") {
    return parseWorkflow(rest.slice(1));
  }

  if (first === "learn") return parseLearn(rest.slice(1));

  if (first === "library") return parseLibrary(rest.slice(1));

  if (first === "context") {
    return parseContext(rest.slice(1));
  }

  if (first === "doctor") {
    return parseDoctor(rest.slice(1), learning);
  }

  if (first === "config") {
    return parseConfig(rest.slice(1));
  }

  if (first === "session") {
    return parseSession(rest.slice(1));
  }

  if (first === "login") {
    return parseLogin(rest.slice(1));
  }

  if (first === "logout") {
    return parseLogout(rest.slice(1));
  }

  if (first === "status") {
    return parseAuthStatus(rest.slice(1));
  }

  if (first === "auth") {
    return parseAuthCommand(rest.slice(1));
  }

  if (first === "mcp") {
    return parseMcp(rest.slice(1));
  }

  if (first === "completion") {
    return parseCompletion(rest.slice(1));
  }

  if (first === "checkpoint") {
    return parseCheckpoint(rest.slice(1));
  }

  if (first === "queue") {
    return parseQueue(rest.slice(1));
  }

  if (first === "diff") {
    return parseDiff(rest.slice(1));
  }

  if (first === "review") {
    return parseReview(rest.slice(1));
  }

  if (first === "providers") {
    return parseProviders(rest.slice(1));
  }

  if (first === "memory") {
    return parseMemory(rest.slice(1));
  }

  // Command families parse themselves (`schedule`, `daemon`, `bg`): the root's job
  // is to recognise the word, not to learn what a schedule id looks like. The
  // words come from `command-vocabulary.ts`, which is also what the help text and
  // the completion scripts are built from, so there is one list to keep honest.
  const familyWord = FAMILY_COMMAND_WORDS.find((word) => word === first);
  if (familyWord !== undefined) {
    return { kind: "family", word: familyWord, args: rest.slice(1) };
  }

  return usageError(
    `unknown command: ${first}`,
    "run `trylo --help` to list commands",
  );
}

/**
 * `config` takes args past its own word (`rest.slice(1)` at the call site),
 * so `["config", "show"]` arrives here as `["show"]`. Kept as a one-line
 * delegation from the dispatcher: the root recognises the word, this owns the
 * `show`-only shape. No commander/yargs/clap — the family parsers stay the
 * only place that knows flag shapes.
 */
function parseConfig(configArgs: ReadonlyArray<string>): ParsedCommand {
  if (configArgs[0] === "--help" || configArgs[0] === "-h") {
    return familyHelpCommand("config");
  }

  if (configArgs[0] !== "show") {
    return usageError("config requires the `show` subcommand", "try `trylo config show`");
  }

  const shown = parseSimple(configArgs.slice(1), (json) => ({ kind: "config_show", json }), "config show");

  return shown.kind === "help" ? familyHelpCommand("config") : shown;
}

function parseAuthCommand(rest: ReadonlyArray<string>): ParsedCommand {
  const sub = rest[0];
  if (sub === "--help" || sub === "-h") {
    return familyHelpCommand("auth");
  }

  if (sub === "list") {
    return parseAuthList(rest.slice(1));
  }

  if (sub === "switch") {
    return parseAuthSwitch(rest.slice(1));
  }

  if (sub === "delete") {
    return parseAuthDelete(rest.slice(1));
  }

  if (sub === "add") {
    return parseAuthAdd(rest.slice(1));
  }

  if (sub === "status") {
    return parseAuthStatus(rest.slice(1));
  }

  if (sub === "logout") {
    return parseLogout(rest.slice(1));
  }

  return usageError(
    sub === undefined ? "auth requires a subcommand" : `unknown auth subcommand: ${sub}`,
    "try `trylo auth add`, `trylo auth switch`, `trylo auth list`, `trylo auth status`, `trylo auth delete`, or `trylo auth logout`",
  );
}
