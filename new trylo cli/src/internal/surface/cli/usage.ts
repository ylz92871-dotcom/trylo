/**
 * Help text. Kept apart from parsing so wording can change without touching the
 * parser, and so `--help` is provably side-effect free.
 */

import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { TRYLO_VERSION } from "../../protocol/version.js";
import type { ParsedCommand } from "./args-primitives.js";

export const VERSION = TRYLO_VERSION;

export const USAGE = [
  "trylo - learning agent CLI",
  "",
  "Usage:",
  "  trylo                         start the interactive REPL",
  "  trylo run [options] [message] one-shot turn",
  "  trylo run -                   read the prompt from stdin",
  "  trylo exec [options] [message] the same one-shot turn under Codex's spelling (C72)",
  "  trylo help | --help           this list (`version`/`-v` print the version)",
  "  trylo login --provider <id>   store a credential (default scope: user)",
  "  trylo logout --provider <id>  clear a credential's current account",
  "  trylo status [--json]         which layer resolves each provider (no secrets)",
  "  trylo auth list [--project]   stored accounts in one scope",
  "  trylo auth switch             point a provider at another stored account",
  "  trylo auth delete             remove a stored account and its secret",
  "  trylo version                 print the CLI version",
  "  trylo doctor [--json]         read-only environment diagnostics",
  "  trylo config show [--json]    merged config and each value's source layer",
  "  trylo session list [--search <text>] [--all]  list sessions with names and first lines",
  "  trylo session info <id>      what a session is: provider, model, records, reconcile state",
  "  trylo session fork <id>      branch settled history into a new session (never replays the unfinished)",
  "  trylo session rename <id> <name>  name a session",
  "  trylo session export <id>    print the transcript as json (default) or markdown",
  "  trylo session archive <id>   park a session out of the default list (unarchive reverses)",
  "  trylo session remove <id>    delete a session journal and its sidecar (refused under a live lock)",
  "  trylo session reconcile <id>  list actions whose outcome the run could not prove",
  "  trylo session review <id>     one turn's transcript, tool outcomes, file writes and checkpoints (read-only)",
  "  trylo mcp list [--json]       registered MCP servers (merged user + project)",
  "  trylo mcp status [--json]     dial every enabled server and report connected/unavailable/disabled",
  "  trylo mcp add <name> -- <cmd> register a stdio MCP server",
  "  trylo completion <shell>      print a shell completion script (bash|zsh|fish)",
  "  trylo update --check [--json] check the release channel status (check-only; no installer is configured)",
  "  trylo checkpoint list [--json]  snapshots taken before a write",
  "  trylo checkpoint restore <id> [--only <path> ...]  restore one snapshot explicitly (never automatic;",
  "                                          without --only, files created after the snapshot are removed)",
  "  trylo checkpoint diff <id> [--json]  what restoring would change (read-only)",
  "  trylo queue add --session <id> --message <text>  hand a message to a session that is busy or absent",
  "  trylo queue list --session <id> [--json]  what is waiting for that session, oldest first (read-only)",
  "  trylo queue drop --session <id> --id <queued-id>  take one queued message back before it is sent",
  "  trylo diff [--json]           workspace diff including untracked files (read-only; not a git repo reads as empty)",
  "  trylo output-style list [--json]  installed style prompts `run --output-style` can consume (read-only)",
  "  trylo output-style show <name> [--json]  print one style prompt (read-only)",
  "  trylo memory list [--json]            show what Trylo remembers about the user (read-only)",
  "  trylo memory import --file <path>     import a panel export into the user ledger (idempotent)",
  "  trylo memory delete --all --yes       delete every saved user memory on this machine (no undo)",
  "  trylo memory update|retract --json    revise one record using a JSON request on stdin",
  "  trylo memory compact [--json]        atomically retain current versions and consumed command keys",
  "  trylo workflow list [--json]  installed workflow prompts (read-only)",
  "  trylo workflow show <name> [--json]  print one workflow prompt (read-only)",
  "  trylo workflow run <name> [-- <run options>]  run the workflow prompt through the ordinary run pipeline",
  "  trylo context [--session <id> [--turn <turn-id>]] [--json]  inspect run inputs or a session's token shape (read-only)",
  "  trylo review --uncommitted|--base <branch>|--commit <sha>|\"<instructions>\"|-  review target and prompt (findings only; changes nothing; - reads stdin)",
  "  trylo providers add <id>        declare a provider (endpoint, model, account, context-window)",
  "  trylo providers remove <id>     delete a declared provider (built-ins cannot be removed)",
  "  trylo providers edit <id>       change endpoint, model, account and/or context-window (kind cannot change)",
  "  trylo providers models <id>     declared model ids (never guessed from an endpoint)",
  "  trylo providers switch <id>     which provider a run selects when none is named",
  "  trylo providers config [id]     what a run would use, resolved (no secrets)",
  "  trylo schedule add --cron <expr> --prompt <text> [--session <id>] [--once] [--durable]  arm work for later",
  "  trylo schedule list [--json]     what is armed and when it next fires (read-only)",
  "  trylo schedule remove <id>       take one schedule down",
  "  trylo schedule run [--json]      fire everything due now (hands work to the queue; does not wait)",
  "  trylo watch add --message <text> --session <id> [--file-exists <path>|--file-contains <path> --needle <text>|--exit-code <n>|--flag <name>|--at <time>|--in <duration>] [--fire-now]  sleep until a condition or moment",
  "  trylo watch list [--session <id>] [--json]  what is armed or finished (read-only)",
  "  trylo watch cancel <id>       stop an armed watch",
  "  trylo watch check <id> [--json]  is it met right now? dry-run, never fires",
  "  trylo watch forget <id>       drop a fired/cancelled record (never an armed one)",
  "  trylo daemon status [--json]     is the scheduler running, and is it ticking",
  "  trylo daemon start               spawn it (one per machine; a second is refused)",
  "  trylo daemon stop [--force]      ask it to stop, or make it",
  "  trylo bg ps [sessionId]          background jobs on this machine, across processes (read-only)",
  "  trylo bg logs <id> [--follow]    a job's output, from the log file its owner writes",
  "  trylo bg attach <id>             watch a job's output (cannot type into it)",
  "  trylo bg kill <id>               stop a job and everything it started",
  "",
  "global options:",
  "  --learning method               opt in to the method subsystem for run, doctor or the REPL",
  "",
  "mcp options:",
  "  --                            separates the server name from its command (required for add)",
  "  --env KEY=VALUE               repeatable; env is stdio-only and its values are never printed",
  "  --scope user|project          which registry file to touch (default: user)",
  "  --disable                     add the server switched off",
  "  --url <url>                   register a remote server; http or https, and `--transport sse` for legacy HTTP+SSE",
  "  --transport stdio|http|sse    implied by the registration path: stdio with `--`, http with --url",
  "",
  "run options:",
  "  --provider <fixture|fixture-write|openai-compatible|openai-responses>  default: fixture",
  "                                          openai-responses is the Responses wire, chosen per",
  "                                          declaration via `providers add --kind`",
  "  --model <id>                            provider model id",
  "  --reasoning-effort <none|minimal|low|medium|high|xhigh|max>  Chat/Responses reasoning control;",
  "                                          support is decided by the endpoint; no global config change",
  "  --fallback-model <model>                retry once on this model after a transient provider",
  "                                          failure (non-interactive runs only; must differ from --model)",
  "  --allow-writes                          shorthand for --ask writes",
  "  --ask <always|writes|never>             how much the run may decide alone (default: always on a",
  "                                          terminal, never when piped)",
  "  --allow-tools <name,name>               approve these tools without asking (whole names only;",
  "                                          MCP tools as mcp__<server>__<tool>)",
  "  --deny-tools <name,name>                refuse these tools outright, whatever the policy says",
  "  --tools <name,name|none>                select the exact mounted tool catalog for this run;",
  "                                          omitted tools cannot execute; selection grants no approval",
  "  --endpoint <url>                        provider endpoint override",
  "  --format <text|stream-json>             default: text",
  "  --permission-prompt-tool stdio         stream-json host mode: one user frame, then approval replies",
  "  --session <id>                          start a durable session",
  "  --resume <id>                           continue a durable session",
  "  --last                                  continue the newest non-archived session",
  "  --migrate model,catalog                 accept named config drift on resume (workspace/provider never migrate)",
  "  --output-last-message <file>            write the final assistant text",
  "  --output-schema <file>                JSON Schema file the final answer must satisfy;",
  "                                          sent as response_format (chat) or text.format (Responses)",
  "  --output-style <name>                 append a style prompt from `.trylo/output-styles` after the system seeds",
  "                                          (`trylo output-style list` shows names; absent means the built-in default)",
  "  --system-prompt <text>                  replace the assembled system seeds for this run",
  "  --system-prompt-file <file>             same, read from a file (one of the two only)",
  "  --append-system-prompt <text>           add a system message after the seeds for this run",
  "  --append-system-prompt-file <file>      same, read from a file (one of the two only)",
  "  --workspace <path>                      tool workspace root, and the boundary project rules are",
  "                                          read within (default: cwd); AGENTS.md / CLAUDE.md /",
  "                                          GEMINI.md are read from it and the directories below,",
  "                                          never from a parent. `trylo doctor` reports which were",
  "                                          adopted",
  "  --max-iterations <n>                    optional provider request budget",
  "  --max-tokens <n>                        optional total output token budget for this turn",
  "                                          each request gets the remaining budget as max_tokens;",
  "                                          exhausted or truncated runs can continue with --resume",
  "  --max-budget-usd <amount>               dollar ceiling for this run; usage is priced by the",
  "                                          inputPricePerMTok / outputPricePerMTok config keys and the",
  "                                          run ends explicitly when the cost reaches the ceiling",
  "  --learning method                       opt in to the method subsystem (default: off)",
  "  --permission-ledger                     back this run with the durable permission ledger",
  "                                          (default: off; a ledger that cannot be read refuses the run)",
  "  --subagent                              mount the delegate_subagent tool for this run (default: off)",
  "  --shell-isolation <sandbox|host>         process boundary; default sandbox, host keeps caller authority",
    "  --filesystem-access <workspace|reviewed|host>  target scope; default workspace; reviewed admits explicit external targets",
    "  --shell <auto|none|bash|zsh|sh|powershell|cmd>  interpreter override; absent uses settings/direct mode",
  "                                          (neither choice grants tool permission)",
  "  --allow-web                             mount the web_fetch tool for this run (default: off; each",
  "                                          fetch still needs approval)",
  "  --compact-summary=<extractive|model>    who authors compaction summaries (default: extractive)",
  "  --help                                  show this help",
  "",
  "session options:",
  "  --json                          machine-readable output",
  "  --search <text>                 list only sessions whose id or name contains the text",
  "  --all                           list archived sessions too",
  "  --new-id <id>                   fork into this session id (default: generated)",
  "  --before-user-message <n>       fork the history strictly before the nth user message",
  "  --interrupted                   fork everything, leaving the unfinished suffix behind",
  "  --format json|markdown          export shape (default: json)",
  "  --turn <id> --key <k>           which issued action a verdict is about (both, or listing only)",
  "  --outcome committed|failed      what you determined; there is no way to declare an action unknown",
  "  --evidence <text>               what you checked to determine it",
  "",
  "  --json                          machine-readable output; model lists that are not declared",
  "                                  are reported as undeclared, never as empty",
  "",
  "credential options:",
  "  --provider <openai-compatible|fixture>  ledger providers are a closed set",
  "  --account <id>                          explicit account id, or --label <text>",
  "  --project                               target the project ledger instead of user",
  "  --secret-file <path>                    read the key from a file; without it a tty prompt is used",
  "                                          a secret on the command line is never accepted",
  "  --oauth                                 loopback OAuth login (machine with a browser)",
  "  --device                                device grant login: authorize the shown code on another",
  "                                          device (needs TRYLO_OAUTH_DEVICE_URL; one of --oauth/--device)",
  "",
  "exit codes: 0 ok, 1 execution failure, 2 usage, 41 auth, 52 config,",
  "            75 temporary failure, 130 cancelled",
].join("\n");

/** A family's own help page (D6 #19): scoped, exit 0, derived from USAGE. */
export function familyHelpCommand(family: string): ParsedCommand {
  return { kind: "family_help", options: { family } };
}

/** The command families with their own `--help` surface (D6 #19). */
export const HELP_FAMILIES = [
  "providers",
  "auth",
  "mcp",
  "session",
  "checkpoint",
  "queue",
  "config",
  "update",
  "output-style",
  "memory",
  "workflow",
  "context",
] as const;

export type HelpFamily = (typeof HELP_FAMILIES)[number];

/** Which usage lines belong to a family: its verbs, plus its options block. */
const FAMILY_VERB_PREFIXES: Readonly<Record<HelpFamily, ReadonlyArray<string>>> = {
  providers: ["  trylo providers "],
  auth: ["  trylo auth ", "  trylo login ", "  trylo logout ", "  trylo status "],
  mcp: ["  trylo mcp "],
  session: ["  trylo session "],
  checkpoint: ["  trylo checkpoint "],
  queue: ["  trylo queue "],
  config: ["  trylo config "],
  update: ["  trylo update "],
  "output-style": ["  trylo output-style "],
  memory: ["  trylo memory "],
  workflow: ["  trylo workflow "],
  context: ["  trylo context "],
};

const FAMILY_OPTION_BLOCKS: Readonly<Record<HelpFamily, string | undefined>> = {
  providers: "providers options:",
  auth: "credential options:",
  mcp: "mcp options:",
  session: "session options:",
  checkpoint: undefined,
  queue: undefined,
  config: undefined,
  update: undefined,
  "output-style": undefined,
  memory: undefined,
  workflow: undefined,
  context: undefined,
};

/**
 * One family's help, derived from `USAGE` so the two cannot drift: the same
 * literals, filtered. Unknown families yield `undefined` rather than the
 * global text — a help page that silently shows everything answers nothing.
 */
export function familyHelp(family: string): string | undefined {
  if (!(HELP_FAMILIES as readonly string[]).includes(family)) {
    return undefined;
  }
  const lines = USAGE.split("\n");
  const verbs = lines.filter((line) =>
    FAMILY_VERB_PREFIXES[family as HelpFamily].some((prefix) => line.startsWith(prefix)),
  );
  if (verbs.length === 0) {
    return undefined;
  }
  const block = FAMILY_OPTION_BLOCKS[family as HelpFamily];
  const options =
    block === undefined
      ? []
      : ["", ...takeBlock(lines, block)];
  return [`trylo ${family} - commands`, "", ...verbs, ...options, "", "run `trylo --help` for the full surface"].join("\n");
}

/** A `header:` line plus its indented body, up to the next blank line. */
function takeBlock(lines: ReadonlyArray<string>, header: string): string[] {
  const start = lines.indexOf(header);
  if (start < 0) {
    return [];
  }
  const taken = [lines[start] ?? header];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === "") {
      break;
    }
    taken.push(line);
  }
  return taken;
}

/**
 * The exit code contract, in one place (WP C 波 §4.2).
 *
 * `protocol/cli-stream.ts` owns the *values*; this table owns the *promise* —
 * what a parent process may rely on, and what each code means when it sees one.
 * A table-driven test asserts the two never drift, so adding a code to the
 * protocol without saying what it means turns the build red instead of quietly
 * widening the contract.
 *
 * The split is not arbitrary: `0` is success, `2` means the invocation itself
 * was wrong and no retry will help, `41`/`52` name the subsystem that refused,
 * `75` is the only code an outer caller may retry, `130` means a person stopped
 * it, and `1` is everything else. Copied from gemini-cli `exitCodes.ts` and the
 * D6 §10.7 survey of delivery-face conventions.
 */
export type ExitCodeRow = {
  readonly code: ExitCode;
  readonly name: string;
  /** What a parent process should conclude. */
  readonly when: string;
};

export const EXIT_CODE_TABLE: ReadonlyArray<ExitCodeRow> = [
  { code: EXIT_CODES.OK, name: "OK", when: "the command completed" },
  { code: EXIT_CODES.EXECUTION_FAILURE, name: "EXECUTION_FAILURE", when: "execution, model or tool failure" },
  { code: EXIT_CODES.USAGE, name: "USAGE", when: "the invocation itself is wrong; retrying it will not help" },
  { code: EXIT_CODES.AUTH, name: "AUTH", when: "no usable credential; authenticate and retry" },
  { code: EXIT_CODES.CONFIG, name: "CONFIG", when: "a config or registry file is unusable" },
  { code: EXIT_CODES.TEMPORARY, name: "TEMPORARY", when: "rate limit, server, network or timeout; an outer caller may retry" },
  { code: EXIT_CODES.CANCELLED, name: "CANCELLED", when: "a person cancelled the run" },
];
