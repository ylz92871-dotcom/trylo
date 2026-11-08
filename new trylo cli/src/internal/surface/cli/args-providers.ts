import type { ProviderKind } from "../../adapters/provider/providers-file.js";
import { isProviderKind } from "../../adapters/provider/providers-file.js";
import { flagSpecFor, flagToken, parsePositiveInt, parseSimple, readValue, usageError, type FlagSpec } from "./args-tokens.js";
import type { ParsedCommand } from "./args-primitives.js";
import { familyHelpCommand } from "./usage.js";

/**
 * `trylo providers …` argument parsing.
 *
 * One file per command family, like the auth and MCP families before it: the
 * dispatcher in `args.ts` gains one branch and this file owns the rest.
 *
 * The verbs are deliberately different shapes. `list` and `config` read, and
 * `config`'s id is optional because "what am I using right now" is the question
 * a person actually has; `models` and `switch` both require an id, because a
 * model list for "whatever" is not a question this CLI can answer and a switch
 * to nothing is not a switch. `add`/`remove`/`edit` are the writers, all
 * flag-driven because a declaration is four facts — id, kind, endpoint, model
 * — that no one wants to spell positionally or, worse, hand-edit into JSON.
 * `add` refuses a duplicate id (it is not `set`); `edit` patches named fields
 * and keeps the rest, including the account binding unless `--account` rebinds.
 */

export type ProvidersListOptions = {
  readonly json: boolean;
};

export type ProvidersModelsOptions = {
  readonly id: string;
  readonly json: boolean;
};

export type ProvidersSwitchOptions = {
  readonly id: string;
};

export type ProvidersConfigOptions = {
  /** Absent means "the provider a run would select right now". */
  readonly id?: string;
  readonly json: boolean;
};

export type ProvidersAddOptions = {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly endpoint: string;
  readonly model: string;
  /** The ledger account this provider binds to; absent means the family's current. */
  readonly account?: string;
  /** Declared context window in tokens; absent means compaction stays off unless asked. */
  readonly contextWindow?: number;
};

export type ProvidersRemoveOptions = {
  readonly id: string;
};

export type ProvidersEditOptions = {
  readonly id: string;
  /** Absent means "keep what the declaration has" — only an explicit value changes it. */
  readonly endpoint?: string;
  readonly model?: string;
  /** Absent means "keep the existing binding" — only an explicit value rebinds. */
  readonly account?: string;
  /** Absent means "keep the declared window" — only an explicit value changes it. */
  readonly contextWindow?: number;
};

const SUBCOMMANDS = ["list", "models", "switch", "config", "add", "remove", "edit"] as const;

function subcommandHelp(): ParsedCommand {
  return usageError(
    "providers requires a subcommand",
    `try \`trylo providers ${SUBCOMMANDS.join("`, `")}\``,
  );
}

/** One positional id plus the shared `--json`. */
function parseWithId(
  argv: ReadonlyArray<string>,
  make: (id: string, json: boolean) => ParsedCommand,
  name: string,
): ParsedCommand {
  let json = false;
  let id: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      return familyHelpCommand("providers");
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token.startsWith("--")) {
      return usageError(`${name} does not accept ${token}`, `run \`trylo providers ${name} --help\``);
    }

    if (id !== undefined) {
      return usageError(
        `${name} takes one provider id, got a second one: ${token}`,
        `\`trylo providers ${name} <id>\``,
      );
    }

    id = token;
  }

  if (id === undefined || id.length === 0) {
    return usageError(
      `${name} needs a provider id`,
      `\`trylo providers ${name} <id>\`; \`trylo providers list\` shows the known ids`,
    );
  }

  return make(id, json);
}

export function parseProviders(argv: ReadonlyArray<string>): ParsedCommand {
  const sub = argv[0];
  if (sub === undefined) {
    return subcommandHelp();
  }

  if (sub === "--help" || sub === "-h") {
    return familyHelpCommand("providers");
  }

  const rest = argv.slice(1);

  if (sub === "list") {
    const listed = parseSimple(rest, (json) => ({ kind: "providers_list", json }), "providers list");
    return listed.kind === "help" ? familyHelpCommand("providers") : listed;
  }

  if (sub === "models") {
    return parseWithId(rest, (id, json) => ({ kind: "providers_models", options: { id, json } }), "providers models");
  }

  if (sub === "switch") {
    return parseWithId(rest, (id) => ({ kind: "providers_switch", options: { id } }), "providers switch");
  }

  if (sub === "config") {
    // The id is optional here, so `--json` has to be separable from a position:
    // every flag is consumed first and whatever remains is the id.
    let json = false;
    let id: string | undefined;

    for (const token of rest) {
      if (token === "--help" || token === "-h") {
        return familyHelpCommand("providers");
      }

      if (token === "--json") {
        json = true;
        continue;
      }

      if (token.startsWith("--")) {
        return usageError(
          `providers config does not accept ${token}`,
          "run `trylo providers config --help`",
        );
      }

      if (id !== undefined) {
        return usageError(
          `providers config takes one provider id, got a second one: ${token}`,
          "`trylo providers config [id]`",
        );
      }

      id = token;
    }

    return {
      kind: "providers_config",
      options: { ...(id === undefined ? {} : { id }), json },
    };
  }

  if (sub === "add") {
    return parseAdd(rest);
  }

  if (sub === "remove") {
    return parseWithId(rest, (id) => ({ kind: "providers_remove", options: { id } }), "providers remove");
  }

  if (sub === "edit") {
    return parseEdit(rest);
  }

  return usageError(
    `unknown providers subcommand: ${sub}`,
    `accepted subcommands are ${SUBCOMMANDS.join(", ")}`,
  );
}

/** The value flags `providers edit` takes: the mutable subset of a declaration. */
const EDIT_VALUE_FLAGS: ReadonlyArray<FlagSpec> = [
  { name: "endpoint", takesValue: true },
  { name: "model", takesValue: true },
  { name: "account", takesValue: true },
  { name: "context-window", takesValue: true },
];

/**
 * `providers edit <id> [--endpoint <u>] [--model <m>] [--account <a>] [--context-window <n>]`.
 *
 * At least one flag is required — an edit that changes nothing is a usage
 * error, not a no-op write. `--kind` is deliberately not accepted: changing
 * the family re-points the credential lookup (`runCredentialFor` resolves by
 * family), which is a new declaration wearing an old id — that road is
 * `providers remove` + `providers add`, with eyes open.
 */
function parseEdit(argv: ReadonlyArray<string>): ParsedCommand {
  let id: string | undefined;
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      return familyHelpCommand("providers");
    }

    if (!token.startsWith("--")) {
      if (id !== undefined) {
        return usageError(
          `providers edit takes one provider id, got a second one: ${token}`,
          "`trylo providers edit <id> --endpoint <u> --model <m> --account <a> --context-window <n>`",
        );
      }

      id = token;
      continue;
    }

    const parsed = flagToken(token);
    if (parsed === undefined || parsed.name.length === 0) {
      return usageError(`providers edit does not accept ${token}`, "run `trylo providers edit --help`");
    }

    if (parsed.name === "kind") {
      return usageError(
        "providers edit does not accept --kind",
        "changing the family is a new declaration: `trylo providers remove <id>` then `trylo providers add <id> --kind <k> …`",
      );
    }

    const spec = flagSpecFor(EDIT_VALUE_FLAGS, parsed.name);
    if (spec === undefined) {
      return usageError(
        `providers edit does not accept --${parsed.name}`,
        "accepted flags: --endpoint, --model, --account, --context-window",
      );
    }

    const read = readValue(argv, index, parsed.inlineValue);
    if (read.error !== undefined) {
      return usageError(`option --${parsed.name} ${read.error}`, `pass a value, for example --${parsed.name}=<value>`);
    }

    values.set(parsed.name, read.value ?? "");
    index = read.next - 1;
  }

  if (id === undefined || id.length === 0) {
    return usageError(
      "providers edit needs a provider id",
      "`trylo providers edit <id> --endpoint <u> --model <m> --account <a> --context-window <n>`",
    );
  }

  if (values.size === 0) {
    return usageError(
      "providers edit needs at least one of --endpoint, --model, --account, --context-window",
      "`trylo providers edit <id> --endpoint <u> --model <m> --account <a> --context-window <n>`",
    );
  }

  const endpoint = values.get("endpoint");
  const model = values.get("model");
  const account = values.get("account");
  const contextWindow = readContextWindow(values);
  if ("error" in contextWindow) {
    return contextWindow.error;
  }

  return {
    kind: "providers_edit",
    options: {
      id,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(model === undefined ? {} : { model }),
      ...(account === undefined ? {} : { account }),
      ...(contextWindow.value === undefined ? {} : { contextWindow: contextWindow.value }),
    },
  };
}

/** Reads `--context-window <n>` when present, refusing non-positive values. */
function readContextWindow(
  values: ReadonlyMap<string, string>,
): { readonly value?: number } | { readonly error: ParsedCommand } {
  const raw = values.get("context-window");
  if (raw === undefined) {
    return {};
  }

  const parsed = parsePositiveInt(raw);
  if (parsed === undefined) {
    return {
      error: usageError(
        "--context-window must be a positive integer number of tokens",
        "for example --context-window=128000",
      ),
    };
  }

  return { value: parsed };
}

/** The value flags `providers add` takes. A secret is deliberately not one of them. */
const ADD_VALUE_FLAGS: ReadonlyArray<FlagSpec> = [
  { name: "kind", takesValue: true },
  { name: "endpoint", takesValue: true },
  { name: "model", takesValue: true },
  { name: "account", takesValue: true },
  { name: "context-window", takesValue: true },
];

/**
 * `providers add <id> --kind <k> --endpoint <u> --model <m> [--account <a>]`.
 *
 * Only the id is positional; everything else is a flag, so the four facts a
 * declaration carries are visible in the command itself and a rerun of the same
 * command is a no-op-able, diffable line.
 */
function parseAdd(argv: ReadonlyArray<string>): ParsedCommand {
  let id: string | undefined;
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--help" || token === "-h") {
      return familyHelpCommand("providers");
    }

    if (!token.startsWith("--")) {
      if (id !== undefined) {
        return usageError(
          `providers add takes one provider id, got a second one: ${token}`,
          "`trylo providers add <id> --kind <k> --endpoint <u> --model <m>`",
        );
      }

      id = token;
      continue;
    }

    const parsed = flagToken(token);
    if (parsed === undefined || parsed.name.length === 0) {
      return usageError(`providers add does not accept ${token}`, "run `trylo providers add --help`");
    }

    const spec = flagSpecFor(ADD_VALUE_FLAGS, parsed.name);
    if (spec === undefined) {
      return usageError(
        `providers add does not accept --${parsed.name}`,
        "accepted flags: --kind, --endpoint, --model, --account, --context-window",
      );
    }

    const read = readValue(argv, index, parsed.inlineValue);
    if (read.error !== undefined) {
      return usageError(`option --${parsed.name} ${read.error}`, `pass a value, for example --${parsed.name}=<value>`);
    }

    values.set(parsed.name, read.value ?? "");
    index = read.next - 1;
  }

  if (id === undefined || id.length === 0) {
    return usageError(
      "providers add needs a provider id",
      "`trylo providers add <id> --kind <k> --endpoint <u> --model <m>`",
    );
  }

  const kind = values.get("kind") ?? "";
  if (!isProviderKind(kind)) {
    return usageError(
      `providers add needs --kind <k>; ${JSON.stringify(kind)} is not one`,
      "kinds: openai-compatible (Chat Completions), openai-responses (Responses wire); `trylo providers list` shows the built-ins",
    );
  }

  const endpoint = values.get("endpoint") ?? "";
  const model = values.get("model") ?? "";
  const account = values.get("account");
  const contextWindow = readContextWindow(values);
  if ("error" in contextWindow) {
    return contextWindow.error;
  }

  return {
    kind: "providers_add",
    options: {
      id,
      kind,
      endpoint,
      model,
      ...(account === undefined ? {} : { account }),
      ...(contextWindow.value === undefined ? {} : { contextWindow: contextWindow.value }),
    },
  };
}
