import {
  COMPACT_SUMMARY_MODES,
  isCompactSummaryMode,
  type AskPolicy,
  type CompactSummaryMode,
  type LearningSwitch,
  type ParsedCommand,
} from "./args-primitives.js";
import { flagSpecFor, flagToken, readLearning, readValue, usageError, type FlagSpec } from "./args-tokens.js";
import { buildRunOptions, consumePermissionFlag } from "./args-run-options.js";

const RUN_FLAGS: ReadonlyArray<FlagSpec> = [
  { name: "provider", takesValue: true },
  { name: "model", takesValue: true },
  { name: "endpoint", takesValue: true },
  { name: "format", takesValue: true },
  { name: "permission-prompt-tool", takesValue: true },
  { name: "shell-isolation", takesValue: true },
  { name: "filesystem-access", takesValue: true },
  { name: "shell", takesValue: true },
  { name: "session", takesValue: true },
  { name: "resume", takesValue: true },
  { name: "migrate", takesValue: true },
  { name: "output-last-message", takesValue: true },
  { name: "output-schema", takesValue: true },
  { name: "output-style", takesValue: true },
  { name: "system-prompt", takesValue: true },
  { name: "system-prompt-file", takesValue: true },
  { name: "append-system-prompt", takesValue: true },
  { name: "append-system-prompt-file", takesValue: true },
  { name: "fallback-model", takesValue: true },
  { name: "workspace", takesValue: true },
  { name: "max-iterations", takesValue: true },
  { name: "max-tokens", takesValue: true },
  { name: "context-window", takesValue: true },
  { name: "model-context-window", takesValue: true },
  { name: "max-budget-usd", takesValue: true },
  { name: "allow-writes", takesValue: false },
  { name: "ask", takesValue: true },
  { name: "allow-tools", takesValue: true },
  { name: "deny-tools", takesValue: true },
  { name: "tools", takesValue: true },
  { name: "reasoning-effort", takesValue: true },
  { name: "learning", takesValue: true },
  { name: "permission-ledger", takesValue: false },
  { name: "subagent", takesValue: false },
  { name: "allow-web", takesValue: false },
  { name: "compact-summary", takesValue: true },
];

/**
 * The presence-only flags: appearing is the entire meaning, and each maps to
 * one boolean on the parse state. `defaultHint` is the second half of the
 * refusal shown when someone tries to pass a value.
 */
type PresenceFlagKey = "allowWrites" | "permissionLedger" | "subagent" | "allowWeb" | "resumeLast";

const PRESENCE_FLAGS: ReadonlyArray<{
  readonly flag: string;
  readonly key: PresenceFlagKey;
  readonly defaultHint: string;
}> = [
  {
    flag: "allow-writes",
    key: "allowWrites",
    defaultHint: "the default is to deny every mutating tool",
  },
  {
    flag: "permission-ledger",
    key: "permissionLedger",
    defaultHint: "the default is no durable permission ledger",
  },
  {
    flag: "subagent",
    key: "subagent",
    defaultHint: "the default is no delegate_subagent tool",
  },
  { flag: "allow-web", key: "allowWeb", defaultHint: "the default is no web_fetch tool" },
  {
    flag: "last",
    key: "resumeLast",
    defaultHint: "the default is to resume only the session --resume names",
  },
];

function presenceFlagFor(
  name: string,
): { readonly key: PresenceFlagKey; readonly defaultHint: string } | undefined {
  return PRESENCE_FLAGS.find((entry) => entry.flag === name);
}

export type RunParseState = {
  values: Map<string, string>;
  message: string[];
  readStdin: boolean;
  allowWrites: boolean;
  help: boolean;
  ask?: AskPolicy;
  allowTools?: ReadonlyArray<string>;
  denyTools?: ReadonlyArray<string>;
  /** `--permission-ledger` 是否出现。出现即开，与 `--allow-writes` 同形。 */
  permissionLedger: boolean;
  /** `--subagent` 是否出现。出现即开，与 `--permission-ledger` 同形。 */
  subagent: boolean;
  /** `--last` 是否出现：续跑最新的未归档会话，而不是点名。 */
  resumeLast: boolean;
  /** `--allow-web` 是否出现。出现即挂载 `web_fetch`，与 `--subagent` 同形。 */
  allowWeb: boolean;
  /** The validated `--learning` value, kept apart from `values` so its type is the closed set. */
  learning?: LearningSwitch;
  /** The validated `--compact-summary` value, kept apart from `values` for the same reason. */
  compactSummary?: CompactSummaryMode;
  /**
   * A parsed error, kept whole rather than as a `{ message, hint }` pair so a
   * family check (the learning closed set) and a token-level check (a missing
   * value) produce the same thing.
   */
  error?: ParsedCommand;
};

function consumeRunToken(
  state: RunParseState,
  argv: ReadonlyArray<string>,
  index: number,
): number {
  const token = argv[index] ?? "";
  if (token === "--") {
    for (const rest of argv.slice(index + 1)) {
      state.message.push(rest);
    }
    return argv.length;
  }
  if (token === "-") {
    state.readStdin = true;
    return index + 1;
  }
  if (!token.startsWith("--")) {
    state.message.push(token);
    return index + 1;
  }
  const parsed = flagToken(token);
  if (parsed === undefined) {
    state.message.push(token);
    return index + 1;
  }
  const { name, inlineValue } = parsed;
  if (name === "help") {
    state.help = true;
    return index + 1;
  }
  const presence = presenceFlagFor(name);
  if (presence !== undefined) {
    // 出现就是全部含义，所以 `--flag=false` 被拒绝而不是被读成「是」——一个
    // 能被写成「开着但其实关着」的开关不是开关。四个 presence 旗标共享这一
    // 份契约与失败词汇，不各写一遍。
    if (inlineValue !== undefined && inlineValue !== "true") {
      state.error = usageError(
        `--${name} takes no value`,
        `pass --${name} on its own; ${presence.defaultHint}`,
      );
      return argv.length;
    }
    state[presence.key] = true;
    return index + 1;
  }
  if (name === "learning") {
    // The closed set is checked here, not downstream: a misspelled switch must
    // be a usage error rather than a value that quietly means "off".
    const got = readLearning(argv, index, inlineValue);
    if (got.error !== undefined) {
      state.error = got.error;
      return argv.length;
    }
    if (got.value !== undefined) {
      state.learning = got.value;
    }
    return got.next;
  }
  if (name === "compact-summary") {
    // 与 `--ask` / `--learning` 同一形态：值旗标 + 解析处的闭集把关。拼错的模式
    // 必须是用法错误，不能静默变成另一个模式。
    const read = readValue(argv, index, inlineValue);
    if (read.error !== undefined) {
      state.error = usageError(
        `option --${name} ${read.error}`,
        "pass a value, for example --compact-summary=model",
      );
      return argv.length;
    }
    const raw = read.value ?? "";
    if (!isCompactSummaryMode(raw)) {
      state.error = usageError(
        `unknown --${name} value: ${raw}`,
        `use one of: ${COMPACT_SUMMARY_MODES.join(", ")}`,
      );
      return argv.length;
    }
    state.compactSummary = raw;
    return read.next;
  }
  const permission = consumePermissionFlag(state, argv, index, name, inlineValue);
  if (permission !== undefined) {
    return permission;
  }
  const spec = flagSpecFor(RUN_FLAGS, name);
  if (spec === undefined) {
    state.error = usageError(
      `unknown option --${name}`,
      "run `trylo --help` to list supported options",
    );
    return argv.length;
  }
  const read = readValue(argv, index, inlineValue);
  if (read.error !== undefined) {
    state.error = usageError(
      `option --${name} ${read.error}`,
      `pass a value, for example --${name}=<value>`,
    );
    return argv.length;
  }
  state.values.set(name, read.value ?? "");
  return read.next;
}

/**
 * `seed` is a `--learning` already read before the subcommand (`trylo
 * --learning=method run …`); a `--learning` inside the run flags wins, so the
 * more specific placement is the one that decides.
 */
export function parseRun(argv: ReadonlyArray<string>, seed?: LearningSwitch): ParsedCommand {
  const state: RunParseState = {
    values: new Map(),
    message: [],
    readStdin: false,
    allowWrites: false,
    help: false,
    permissionLedger: false,
    subagent: false,
    allowWeb: false,
    resumeLast: false,
    ...(seed === undefined ? {} : { learning: seed }),
  };
  let index = 0;
  while (index < argv.length) {
    index = consumeRunToken(state, argv, index);
  }
  if (state.error !== undefined) {
    return state.error;
  }
  if (state.help) {
    return { kind: "help" };
  }
  return buildRunOptions(state);
}
