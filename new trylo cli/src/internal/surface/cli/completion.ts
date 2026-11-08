import { usageError } from "./args-tokens.js";
import type { ParsedCommand } from "./args-primitives.js";
import { COMMAND_WORDS, FAMILY_SUBCOMMANDS } from "./command-vocabulary.js";

/**
 * Shell completion.
 *
 * Deliberately the dumbest thing in the CLI: a static script per shell, printed
 * to stdout and nothing else. It reads no configuration, asks no port and never
 * looks at a TTY, because completion runs in contexts where all three are
 * unavailable or actively wrong — a non-interactive shell, a `source
 * <(trylo completion bash)` inside a script, or a user whose config is broken.
 * A completion that can fail is a completion that breaks someone's prompt.
 *
 * The command list is repeated per shell script on purpose: each dialect wants
 * its own shape, and a shared generator would have to encode three grammars to
 * save a few lines.
 */

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

/** The `session` verbs, in one place so the three shell scripts cannot drift. */
export const SESSION_VERBS = "list info fork rename export archive unarchive remove reconcile";

/**
 * The words a person may type after `trylo`, from the one vocabulary.
 *
 * This used to be a hand-written copy, and it had already drifted: `checkpoint`,
 * `queue`, `diff`, `review`, `providers`, `schedule` and `daemon` all parse and
 * all work, and none of them completed. A verb that is missing here is a verb
 * nobody finds, which is why the list is derived and
 * `command-vocabulary.test.ts` fails if the router stops claiming a word.
 */
const TOP_LEVEL = COMMAND_WORDS;

const BASH_SCRIPT = [
  "# trylo completion for bash. Source it, or drop it in /etc/bash_completion.d/.",
  "_trylo_completions() {",
  "  local cur prev",
  "  cur=\"${COMP_WORDS[COMP_CWORD]}\"",
  "  prev=\"${COMP_WORDS[COMP_CWORD-1]}\"",
  "  case \"$prev\" in",
  "    mcp)        COMPREPLY=( $(compgen -W \"add list status remove enable disable\" -- \"$cur\") ); return 0 ;;",
  "    config)     COMPREPLY=( $(compgen -W \"show\" -- \"$cur\") ); return 0 ;;",
  "    session)    COMPREPLY=( $(compgen -W \"" + SESSION_VERBS + "\" -- \"$cur\") ); return 0 ;;",
  "    auth)       COMPREPLY=( $(compgen -W \"list switch\" -- \"$cur\") ); return 0 ;;",
  "    output-style) COMPREPLY=( $(compgen -W \"list show\" -- \"$cur\") ); return 0 ;;",
  "    workflow)   COMPREPLY=( $(compgen -W \"list show run\" -- \"$cur\") ); return 0 ;;",
  "    learn)      COMPREPLY=( $(compgen -W \"collaboration skill\" -- \"$cur\") ); return 0 ;;",
  "    library)    COMPREPLY=( $(compgen -W \"tool expert\" -- \"$cur\") ); return 0 ;;",
  "    completion) COMPREPLY=( $(compgen -W \"bash zsh fish\" -- \"$cur\") ); return 0 ;;",
  ...Object.entries(FAMILY_SUBCOMMANDS).map(
    ([word, verbs]) =>
      `    ${word})      COMPREPLY=( $(compgen -W "${verbs.join(" ")} --help" -- "$cur") ); return 0 ;;`,
  ),
  "  esac",
  `  COMPREPLY=( $(compgen -W "${TOP_LEVEL.join(" ")} --help --version -h -v" -- "$cur") )`,
  "  return 0",
  "}",
  "complete -F _trylo_completions trylo",
  "",
].join("\n");

const ZSH_SCRIPT = [
  "#compdef trylo",
  "# trylo completion for zsh. Drop it on your $fpath as `_trylo`.",
  "_trylo() {",
  "  local state",
  "  local -a commands",
  "  commands=(",
  ...TOP_LEVEL.map((command) => `    '${command}'`),
  "  )",
  "  _arguments -C '1: :->command' '*:: :->args'",
  "  case \"$state\" in",
  "    command)",
  "      _describe -t commands 'trylo command' commands",
  "      ;;",
  "    args)",
  "      case \"$words[1]\" in",
  "        mcp)        _values 'mcp subcommand' 'add' 'list' 'status' 'remove' 'enable' 'disable' ;;",
  "        config)     _values 'config subcommand' 'show' ;;",
  "        session)    _values 'session subcommand' " + SESSION_VERBS.split(" ").map((verb) => `'${verb}'`).join(" ") + " ;;",
  "        auth)       _values 'auth subcommand' 'list' 'switch' ;;",
  "        output-style) _values 'output-style subcommand' 'list' 'show' ;;",
  "        workflow)   _values 'workflow subcommand' 'list' 'show' 'run' ;;",
  "        learn)      _values 'learning subsystem' 'collaboration' 'skill' ;;",
  "        library)    _values 'library' 'tool' 'expert' ;;",
  "        completion) _values 'shell' 'bash' 'zsh' 'fish' ;;",
  ...Object.entries(FAMILY_SUBCOMMANDS).map(
    ([word, verbs]) =>
      `        ${word})      _values '${word} subcommand' ${verbs.map((verb) => `'${verb}'`).join(" ")} 'help' ;;`,
  ),
  "      esac",
  "      ;;",
  "  esac",
  "}",
  "compdef _trylo trylo",
  "",
].join("\n");

const FISH_SCRIPT = [
  "# trylo completion for fish. Drop it in ~/.config/fish/completions/trylo.fish.",
  "complete -c trylo -f",
  ...TOP_LEVEL.flatMap((command) => [
    `complete -c trylo -n '__fish_use_subcommand' -a '${command}'`,
  ]),
  "complete -c trylo -n '__fish_use_subcommand' -a 'help' -d 'show the command list'",
  "complete -c trylo -n '__fish_seen_subcommand_from mcp' -a 'add list status remove enable disable'",
  "complete -c trylo -n '__fish_seen_subcommand_from config' -a 'show'",
  "complete -c trylo -n '__fish_seen_subcommand_from session' -a '" + SESSION_VERBS + "'",
  "complete -c trylo -n '__fish_seen_subcommand_from auth' -a 'list switch'",
  "complete -c trylo -n '__fish_seen_subcommand_from output-style' -a 'list show'",
  "complete -c trylo -n '__fish_seen_subcommand_from workflow' -a 'list show run'",
  "complete -c trylo -n '__fish_seen_subcommand_from learn' -a 'collaboration skill'",
  "complete -c trylo -n '__fish_seen_subcommand_from library' -a 'tool expert'",
  "complete -c trylo -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'",
  ...Object.entries(FAMILY_SUBCOMMANDS).map(
    ([word, verbs]) =>
      `complete -c trylo -n '__fish_seen_subcommand_from ${word}' -a '${verbs.join(" ")}'`,
  ),
  "",
].join("\n");

const SCRIPTS: Readonly<Record<CompletionShell, string>> = {
  bash: BASH_SCRIPT,
  zsh: ZSH_SCRIPT,
  fish: FISH_SCRIPT,
};

export function completionScript(shell: CompletionShell): string {
  return SCRIPTS[shell];
}

/**
 * `completion <shell>` — one argument, no options.
 *
 * An unknown shell is a usage error (exit 2) rather than an empty stdout: a
 * silent nothing is what makes `source <(trylo completion oops)` look like it
 * worked.
 */
export function parseCompletion(argv: ReadonlyArray<string>): ParsedCommand {
  const shell = argv[0];
  if (shell === undefined) {
    return usageError("completion requires a shell", "try `trylo completion bash|zsh|fish`");
  }

  if (!isCompletionShell(shell)) {
    return usageError(
      `unknown shell: ${shell}`,
      `completion supports ${COMPLETION_SHELLS.join(", ")} only`,
    );
  }

  if (argv.length > 1) {
    return usageError(`completion takes one argument; got ${argv.length}`, "try `trylo completion bash`");
  }

  return { kind: "completion", shell };
}
