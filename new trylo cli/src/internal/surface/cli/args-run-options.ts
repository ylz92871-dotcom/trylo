import {
  ASK_POLICIES,
  isAskPolicy,
  isMigrationScopeName,
  isOutputFormat,
  MIGRATION_SCOPES,
  OUTPUT_FORMATS,
  PROVIDER_IDS,
  type ParsedCommand,
  type RunCommandOptions,
} from "./args-primitives.js";
import { parsePositiveInt, readValue, usageError } from "./args-tokens.js";
import { stdioOptionError } from "./args-stdio.js";
import { emptyToolListMessage, isApprovableToolName, unknownToolMessage } from "./permission-plan.js";
import type { RunParseState } from "./args-run.js";
import { parseToolSelection } from "./tool-selection.js";
import { isReasoningEffort, REASONING_EFFORTS } from "../../ports/provider.js";

/**
 * `run` option assembly: from a filled parse state to `RunCommandOptions`.
 *
 * Split out of `args-run.ts` so both files stay under the package file limit.
 * Token consumption stays in `args-run.ts`; everything that *decides* —
 * closed-set checks, conflicts, defaults — lives here. The `RunParseState`
 * import is type-only, so there is no runtime cycle back to the consumer.
 */

/**
 * A comma-separated list of tool names. Only whole names are accepted — a
 * family (`Bash(git:*)`) is not something this CLI can approve one call at a
 * time. Unknown names are a usage error, not a silent denial; MCP names pass
 * by syntax (see `isApprovableToolName`), existence is the sandbox's call.
 */
function readToolList(
  raw: string,
): { readonly ok: true; readonly names: ReadonlyArray<string> } | { readonly ok: false; readonly message: string } {
  const names = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (names.length === 0) {
    return { ok: false, message: emptyToolListMessage() };
  }
  const unknown = names.filter((name) => !isApprovableToolName(name));
  if (unknown.length > 0) {
    return { ok: false, message: unknownToolMessage(unknown) };
  }
  return { ok: true, names };
}

/**
 * The three permission flags. `--ask` picks a policy, the two lists name tools;
 * all three are read here rather than downstream so a bad value is a usage
 * error (exit 2) instead of a run that quietly decides differently.
 *
 * Returns `undefined` when the flag is not one of these three.
 */
export function consumePermissionFlag(
  state: RunParseState,
  argv: ReadonlyArray<string>,
  index: number,
  name: string,
  inlineValue: string | undefined,
): number | undefined {
  if (name !== "ask" && name !== "allow-tools" && name !== "deny-tools") {
    return undefined;
  }
  const read = readValue(argv, index, inlineValue);
  if (read.error !== undefined) {
    state.error = usageError(
      `option --${name} ${read.error}`,
      `pass a value, for example --${name}=<value>`,
    );
    return argv.length;
  }
  const raw = read.value ?? "";
  if (name === "ask") {
    if (!isAskPolicy(raw)) {
      state.error = usageError(
        `unknown --ask policy: ${raw}`,
        `use one of: ${ASK_POLICIES.join(", ")}`,
      );
      return read.next;
    }
    state.ask = raw;
    return read.next;
  }
  const list = readToolList(raw);
  if (!list.ok) {
    state.error = usageError(`--${name} ${list.message}`, `for example --${name}=write_file`);
    return argv.length;
  }
  if (name === "allow-tools") {
    state.allowTools = list.names;
  } else {
    state.denyTools = list.names;
  }
  return read.next;
}

function optionalPositiveInt(
  state: RunParseState,
  name: string,
): number | undefined | "invalid" {
  const raw = state.values.get(name);
  if (raw === undefined) {
    return undefined;
  }
  return parsePositiveInt(raw) ?? "invalid";
}

/**
 * A positive number, decimals allowed: the dollar budget is a quantity of
 * money, not a token count, so `--max-budget-usd=0.50` is a valid ceiling.
 */
function optionalPositiveNumber(
  state: RunParseState,
  name: string,
): number | undefined | "invalid" {
  const raw = state.values.get(name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (raw.trim().length === 0 || !Number.isFinite(parsed) || parsed <= 0) {
    return "invalid";
  }
  return parsed;
}

export function buildRunOptions(state: RunParseState): ParsedCommand {
  const shellIsolation = state.values.get("shell-isolation");
  if (shellIsolation !== undefined && shellIsolation !== "sandbox" && shellIsolation !== "host") {
    return usageError("invalid --shell-isolation", "use sandbox (default) or host (caller authority; approval still required)");
  }
  const effort = state.values.get("reasoning-effort");
  if (effort !== undefined && !isReasoningEffort(effort)) return usageError("invalid --reasoning-effort", `use ${REASONING_EFFORTS.join(", ")}`);
  const toolsRaw = state.values.get("tools");
  const selection = toolsRaw === undefined ? undefined : parseToolSelection(toolsRaw);
  if (selection !== undefined && !selection.ok) return usageError(selection.message, "use --tools=read_file,write_file,run_shell,todo_write or --tools=none");
  const providerRaw = state.values.get("provider");
  // Whether an id names a real provider is decided against the profile at
  // runtime (`providers add` can declare ids this parser cannot know); here
  // only an empty value is a usage error.
  if (providerRaw !== undefined && providerRaw.trim().length === 0) {
    return usageError(
      "--provider requires a value",
      `a shipped id (${PROVIDER_IDS.join(", ")}) or one from \`trylo providers add\``,
    );
  }
  const formatRaw = state.values.get("format");
  const promptTransport = state.values.get("permission-prompt-tool");
  const stdioError = stdioOptionError(promptTransport, formatRaw, state.message);
  if (stdioError !== undefined) return stdioError;
  if (formatRaw !== undefined && !isOutputFormat(formatRaw)) {
    return usageError(
      `unknown format: ${formatRaw}`,
      `use one of: ${OUTPUT_FORMATS.join(", ")}`,
    );
  }
  const session = state.values.get("session");
  const resume = state.values.get("resume");
  if (session !== undefined && resume !== undefined) {
    return usageError(
      "--session and --resume cannot be used together",
      "--session starts a new session; --resume continues an existing one",
    );
  }
  if (state.resumeLast && (session !== undefined || resume !== undefined)) {
    return usageError(
      "--last cannot be used with --session or --resume",
      "--last continues the newest session; --resume <id> continues the one you name",
    );
  }
  const migrateRaw = state.values.get("migrate");
  let migrateModel = false;
  let migrateCatalog = false;
  if (migrateRaw !== undefined) {
    if (resume === undefined && !state.resumeLast) {
      return usageError(
        "--migrate needs --resume (or --last)",
        "migration accepts drift on a session you continue, not on a new one",
      );
    }
    const scopes = migrateRaw.split(",").map(entry => entry.trim()).filter(entry => entry.length > 0);
    if (scopes.length === 0) {
      return usageError("--migrate requires a value", `use --migrate=${MIGRATION_SCOPES.join(",")} (any combination)`);
    }
    for (const scope of scopes) {
      if (!isMigrationScopeName(scope)) {
        return usageError(
          `unknown --migrate scope: ${scope}`,
          `use --migrate=${MIGRATION_SCOPES.join(",")} (any combination); workspace and provider drift never migrate`,
        );
      }
      if (scope === "model") {
        migrateModel = true;
      } else {
        migrateCatalog = true;
      }
    }
  }
  const maxIterations = optionalPositiveInt(state, "max-iterations");
  if (maxIterations === "invalid") {
    return usageError("--max-iterations must be a positive integer", "for example --max-iterations=8");
  }
  const maxTokens = optionalPositiveInt(state, "max-tokens");
  if (maxTokens === "invalid") {
    return usageError("--max-tokens must be a positive integer", "for example --max-tokens=4096");
  }
  const maxBudgetUsd = optionalPositiveNumber(state, "max-budget-usd");
  if (maxBudgetUsd === "invalid") {
    return usageError(
      "--max-budget-usd must be a positive number",
      "for example --max-budget-usd=5, and set the pricing keys so the budget can be priced",
    );
  }
  const model = state.values.get("model");
  const endpoint = state.values.get("endpoint");
  const outputLastMessage = state.values.get("output-last-message");
  const outputSchema = state.values.get("output-schema");
  // A style name is a filename stem (see output-styles.ts); an empty value
  // or a path here would resolve to nothing, and resolving to nothing must
  // be a usage error now rather than a run that silently ignored the flag.
  const outputStyleRaw = state.values.get("output-style");
  if (outputStyleRaw !== undefined && outputStyleRaw.trim().length === 0) {
    return usageError(
      "--output-style requires a value",
      "pass a style name from `trylo output-style list`, or drop the flag",
    );
  }
  const systemPrompt = state.values.get("system-prompt");
  const systemPromptFile = state.values.get("system-prompt-file");
  const appendSystemPrompt = state.values.get("append-system-prompt");
  const appendSystemPromptFile = state.values.get("append-system-prompt-file");
  // Legacy mutual exclusion, word for word: a prompt and its file are two
  // spellings of one fact, and accepting both would need a precedence nobody
  // wrote down (`trylo cli/src/main.tsx:1394,1415`).
  if (systemPrompt !== undefined && systemPromptFile !== undefined) {
    return usageError(
      "Cannot use both --system-prompt and --system-prompt-file. Please use only one.",
      "pass the text inline or a path, not both",
    );
  }
  if (appendSystemPrompt !== undefined && appendSystemPromptFile !== undefined) {
    return usageError(
      "Cannot use both --append-system-prompt and --append-system-prompt-file. Please use only one.",
      "pass the text inline or a path, not both",
    );
  }
  const fallbackModel = state.values.get("fallback-model");
  // Legacy validation, same sentence: a fallback that is the primary retries
  // the same model under a different name (`trylo cli/src/main.tsx:1386`).
  if (fallbackModel !== undefined && model !== undefined && fallbackModel === model) {
    return usageError(
      "Fallback model cannot be the same as the main model. Please specify a different model for --fallback-model.",
      "for example --model lab-7b --fallback-model lab-70b",
    );
  }
  const workspace = state.values.get("workspace");
  const options: RunCommandOptions = {
    ...(shellIsolation === undefined ? {} : { shellIsolation }),
    ...(promptTransport === undefined ? {} : { permissionPromptTool: "stdio" }),
    message: state.message,
    readStdin: state.readStdin,
    ...(providerRaw === undefined ? {} : { provider: providerRaw }),
    ...(formatRaw === undefined ? {} : { format: formatRaw }),
    ...(model === undefined ? {} : { model }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(session === undefined ? {} : { session }),
    ...(resume === undefined ? {} : { resume }),
    ...(state.resumeLast ? { resumeLast: true as const } : {}),
    ...(migrateModel ? { migrateModel: true as const } : {}),
    ...(migrateCatalog ? { migrateCatalog: true as const } : {}),
    ...(outputLastMessage === undefined ? {} : { outputLastMessage }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(outputStyleRaw === undefined ? {} : { outputStyle: outputStyleRaw.trim() }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(systemPromptFile === undefined ? {} : { systemPromptFile }),
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
    ...(appendSystemPromptFile === undefined ? {} : { appendSystemPromptFile }),
    ...(fallbackModel === undefined ? {} : { fallbackModel }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    ...(state.allowWrites ? { allowWrites: true } : {}),
    ...(state.ask === undefined ? {} : { ask: state.ask }),
    ...(state.allowTools === undefined ? {} : { allowTools: state.allowTools }),
    ...(selection === undefined ? {} : { toolSelection: selection.names }),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(state.denyTools === undefined ? {} : { denyTools: state.denyTools }),
    ...(state.learning === undefined ? {} : { learning: state.learning }),
    ...(state.permissionLedger ? { permissionLedger: true } : {}),
    ...(state.subagent ? { subagent: true } : {}),
    ...(state.allowWeb ? { allowWeb: true } : {}),
    ...(state.compactSummary === undefined ? {} : { compactSummary: state.compactSummary }),
  };
  return { kind: "run", options };
}
