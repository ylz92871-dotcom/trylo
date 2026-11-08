/**
 * The REPL's slash command table.
 *
 * One table, three jobs: what `/help` prints, which tokens are commands at all,
 * and — the part that matters — which inputs are *not* prompts. An unrecognised
 * slash token is reported as unknown and dropped; it is never forwarded to the
 * model as if it were something the user said. That is the whole reason the
 * table exists rather than a chain of `if` bodies: with a chain, a typo silently
 * becomes a prompt, and the only way to notice is to read the transcript.
 *
 * Table-driven, not reflection-driven: aider discovers `cmd_*` methods by
 * inspection, which is neat until a method you did not mean to expose becomes a
 * command. Here a command is a command because it appears in this array.
 */

export type SlashKind =
  | "help"
  | "new"
  | "resume"
  | "model"
  | "connect"
  | "settings"
  | "compact"
  | "status"
  | "usage"
  | "doctor"
  | "mode"
  | "allow"
  | "deny"
  | "revoke"
  | "grants"
  | "details"
  | "diff"
  | "review"
  | "rollback"
  | "exit";

export type SlashCommand = {
  /** With its leading slash, as the user types it. */
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly arg?: string;
  readonly summary: string;
  readonly kind: SlashKind;
};

export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: "/help", aliases: ["/?"], summary: "查看命令与快捷键", kind: "help" },
  { name: "/new", aliases: [], summary: "开始新会话", kind: "new" },
  { name: "/resume", aliases: [], arg: "[session-id]", summary: "选择并恢复会话", kind: "resume" },
  { name: "/model", aliases: ["/models"], arg: "[model-id]", summary: "更换模型（开启新会话）", kind: "model" },
  { name: "/connect", aliases: [], arg: "[edit <id>]", summary: "添加或编辑模型连接", kind: "connect" },
  { name: "/settings", aliases: [], summary: "查看当前连接与配置，修改设置", kind: "settings" },
  { name: "/compact", aliases: [], summary: "summarise the history and keep going", kind: "compact" },
  { name: "/status", aliases: [], summary: "session id, provider, model, budget", kind: "status" },
  { name: "/usage", aliases: ["/cost"], summary: "tokens and time the last turn took", kind: "usage" },
  { name: "/doctor", aliases: [], summary: "check config, provider and credentials", kind: "doctor" },
  { name: "/mode", aliases: [], arg: "[read-only|confirm|auto-edit]", summary: "选择操作权限", kind: "mode" },
  { name: "/allow", aliases: [], arg: "<tool>", summary: "approve a whole tool for this session", kind: "allow" },
  { name: "/deny", aliases: [], arg: "<tool>", summary: "deny a whole tool for this session", kind: "deny" },
  { name: "/revoke", aliases: [], arg: "<tool>", summary: "forget a tool's allow/deny and its calls", kind: "revoke" },
  { name: "/grants", aliases: [], arg: "[revoke <pattern>]", summary: "show permissions, or revoke one grant", kind: "grants" },
  { name: "/details", aliases: [], arg: "[last|<n>|call-id]", summary: "show a tool result in full", kind: "details" },
  { name: "/diff", aliases: [], summary: "show the workspace diff, untracked files included", kind: "diff" },
  { name: "/review", aliases: [], arg: "[<n>|<turn-id>]", summary: "review one turn: tools, files, checkpoints, problems", kind: "review" },
  { name: "/rollback", aliases: [], arg: "<n>", summary: "preview returning to the nth user message", kind: "rollback" },
  { name: "/exit", aliases: ["/quit"], summary: "leave the REPL", kind: "exit" },
];

export function isSlashInput(input: string): boolean {
  return input.startsWith("/");
}

/**
 * Tab completion for command names.
 *
 * A person who cannot remember whether it is `/usage` or `/cost` has two
 * options without this: guess, or open `/help`. Both cost more than a Tab.
 * Only the token being typed is completed — a partial word in the middle of
 * a line is left alone, because replacing it would rewrite what they said.
 *
 * Shaped for `readline`'s completer contract: `[completions, originalLine]`.
 */
export function slashCompleter(line: string): [ReadonlyArray<string>, string] {
  const token = line.trimStart();
  if (!token.startsWith("/")) {
    return [[], line];
  }

  const names = SLASH_COMMANDS.map((command) => command.name).filter((name) =>
    name.startsWith(token),
  );

  // One hit and the shell would replace the whole line, so it is returned
  // alone; several and the shell shows the list instead.
  return [names, line];
}

/** Matches on the primary name and on aliases. `/resume` and `/resume x` both hit. */
export function findSlashCommand(token: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find(
    (command) => command.name === token || command.aliases.includes(token),
  );
}

export type SlashInvocation = {
  readonly command: SlashCommand;
  /** Everything after the command token, trimmed. Empty when none was given. */
  readonly arg: string;
};

export type SlashParse =
  | { readonly kind: "not_a_command" }
  | { readonly kind: "known"; readonly invocation: SlashInvocation }
  | { readonly kind: "unknown"; readonly token: string };

/**
 * Classify one REPL line.
 *
 * `not_a_command` is a prompt. `unknown` is a slash token this build does not
 * know, which the caller must report rather than send. The distinction is the
 * contract the table exists to hold.
 */
export function parseSlash(input: string): SlashParse {
  if (!isSlashInput(input)) {
    return { kind: "not_a_command" };
  }

  const trimmed = input.trim();
  const firstSpace = /[\t ]/.exec(trimmed)?.index ?? trimmed.length;
  const token = trimmed.slice(0, firstSpace);
  const command = findSlashCommand(token);
  if (command === undefined) {
    return { kind: "unknown", token };
  }

  return { kind: "known", invocation: { command, arg: trimmed.slice(firstSpace).trim() } };
}

/**
 * The keys worth knowing, printed under the command list.
 *
 * Not a keymap dump: only the three a person hits by reflex and cannot
 * discover otherwise. Multi-line is first because it is the one that silently
 * mangles a pasted prompt when you do not know it exists.
 */
const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["\\ + enter", "continue on the next line"],
  ["up / down", "walk back through what you typed"],
  ["tab", "complete a command name"],
  ["ctrl-r", "search input history"],
  ["ctrl-g", "edit the draft in your editor"],
  ["ctrl-c", "stop this turn; twice to leave"],
];

/** The widest key plus a gutter, so every description starts on one column. */
function keyLines(): ReadonlyArray<string> {
  const wide = Math.max(...KEYS.map(([key]) => key.length)) + 2;
  return KEYS.map(([key, what]) => `  ${key.padEnd(wide)}${what}`);
}

export function slashHelpText(): string {
  const rows = SLASH_COMMANDS.map((command) => {
    const arg = command.arg === undefined ? "" : ` ${command.arg}`;
    return { left: `  ${command.name}${arg}`, summary: command.summary };
  });
  // Padded to the widest command, not to a guessed width: `/resume` takes an
  // argument and is longer than the rest, and a fixed column pushes its
  // summary hard against the name.
  const wide = Math.max(...rows.map((row) => row.left.length));
  const lines = rows.map((row) => `${row.left.padEnd(wide)}  ${row.summary}`);

  return ["commands:", ...lines, "", "keys:", ...keyLines()].join("\n");
}
