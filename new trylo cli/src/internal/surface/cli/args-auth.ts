import {
  CREDENTIAL_PROVIDER_IDS,
  isCredentialProviderId,
  type ParsedCommand,
} from "./args-primitives.js";
import {
  flagSpecFor,
  flagToken,
  readValue,
  usageError,
  type FlagSpec,
} from "./args-tokens.js";
import { familyHelpCommand } from "./usage.js";

/**
 * The credential command family: `login`, `logout`, `status`, `auth list`,
 * `auth switch`. Parsing only — every semantic decision is made by the
 * `CredentialPort` behind `commands-auth.ts`.
 *
 * One rule here is security, not style: **a secret never enters argv**. There is
 * no `--secret` flag, and the names a user might plausibly reach for are refused
 * by name so the failure says what to do instead of merely not working.
 */

const AUTH_VALUE_FLAGS: ReadonlyArray<FlagSpec> = [
  { name: "provider", takesValue: true },
  { name: "account", takesValue: true },
  { name: "label", takesValue: true },
  { name: "secret-file", takesValue: true },
];

const AUTH_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["project", "oauth", "device"]);

const SECRET_FLAG_NAMES: ReadonlySet<string> = new Set([
  "secret",
  "key",
  "token",
  "api-key",
  "apikey",
  "password",
]);

type AuthFlags = {
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
};

type AuthFlagsOrStop = AuthFlags | ParsedCommand;

function isStop(value: AuthFlagsOrStop): value is ParsedCommand {
  return "kind" in value;
}

type AuthState = {
  values: Map<string, string>;
  booleans: Set<string>;
  help: boolean;
  error?: { message: string; hint: string };
};

function unexpected(state: AuthState, token: string): void {
  state.error = {
    message: `unexpected argument: ${token}`,
    hint: "credential commands take flags only, for example --provider <id>",
  };
}

function consumeAuthToken(state: AuthState, argv: ReadonlyArray<string>, index: number): number {
  const token = argv[index] ?? "";
  const parsed = token.startsWith("--") ? flagToken(token) : undefined;
  if (parsed === undefined) {
    unexpected(state, token);
    return argv.length;
  }

  const { name, inlineValue } = parsed;

  if (name.length === 0) {
    unexpected(state, token);
    return argv.length;
  }

  if (name === "help") {
    state.help = true;
    return index + 1;
  }

  if (SECRET_FLAG_NAMES.has(name)) {
    state.error = {
      message: `--${name} is not accepted: a secret on the command line leaks into shell history`,
      hint: "use --secret-file <path>, or run without one and type the secret at the prompt",
    };
    return argv.length;
  }

  if (AUTH_BOOLEAN_FLAGS.has(name)) {
    if (inlineValue !== undefined) {
      state.error = {
        message: `--${name} takes no value`,
        hint: "pass --project on its own to target the project ledger",
      };
      return argv.length;
    }

    state.booleans.add(name);

    return index + 1;
  }

  if (flagSpecFor(AUTH_VALUE_FLAGS, name) === undefined) {
    state.error = {
      message: `unknown option --${name}`,
      hint: "run `trylo --help` to list the credential commands",
    };
    return argv.length;
  }

  const read = readValue(argv, index, inlineValue);
  if (read.error !== undefined) {
    state.error = {
      message: `option --${name} ${read.error}`,
      hint: `pass a value, for example --${name}=<value>`,
    };
    return argv.length;
  }

  state.values.set(name, read.value ?? "");

  return read.next;
}

function parseAuthFlags(argv: ReadonlyArray<string>): AuthFlagsOrStop {
  const state: AuthState = { values: new Map(), booleans: new Set(), help: false };
  let index = 0;

  while (index < argv.length) {
    index = consumeAuthToken(state, argv, index);
  }

  if (state.error !== undefined) {
    return usageError(state.error.message, state.error.hint);
  }

  if (state.help) {
    return familyHelpCommand("auth");
  }

  return { values: state.values, booleans: state.booleans };
}

function providerFlag(
  flags: AuthFlags,
  command: string,
): { readonly provider: "openai-compatible" | "fixture" } | ParsedCommand {
  const raw = flags.values.get("provider");
  if (raw === undefined) {
    return usageError(
      `${command} requires --provider <id>`,
      `use one of: ${CREDENTIAL_PROVIDER_IDS.join(", ")}`,
    );
  }

  if (!isCredentialProviderId(raw)) {
    return usageError(
      `unknown provider: ${raw}`,
      `use one of: ${CREDENTIAL_PROVIDER_IDS.join(", ")}`,
    );
  }

  return { provider: raw };
}

function firstUnexpected(
  argv: ReadonlyArray<string>,
  accepted: ReadonlyArray<string>,
): string | undefined {
  return argv.find((token) => !accepted.includes(token));
}

export function parseLogin(argv: ReadonlyArray<string>): ParsedCommand {
  const flags = parseAuthFlags(argv);
  if (isStop(flags)) {
    return flags;
  }

  // `--oauth` (loopback callback) and `--device` (RFC 8628 poll) are two
  // spellings of one OAuth login; accepting both would need a precedence
  // nobody wrote down.
  if (flags.booleans.has("oauth") && flags.booleans.has("device")) {
    return usageError(
      "login accepts only one of --oauth and --device",
      "use --oauth on a machine with a browser, --device on a headless one",
    );
  }

  const provider = providerFlag(flags, "login");
  if ("kind" in provider) {
    return provider;
  }

  const account = flags.values.get("account");
  const label = flags.values.get("label");
  const secretFile = flags.values.get("secret-file");

  return {
    kind: "login",
    options: {
      provider: provider.provider,
      ...(flags.booleans.has("project") ? { project: true } : {}),
      ...(flags.booleans.has("oauth") ? { oauth: true } : {}),
      ...(flags.booleans.has("device") ? { device: true } : {}),
      ...(account === undefined ? {} : { account }),
      ...(label === undefined ? {} : { label }),
      ...(secretFile === undefined ? {} : { secretFile }),
    },
  };
}

export function parseAuthAdd(argv: ReadonlyArray<string>): ParsedCommand {
  const flags = parseAuthFlags(argv);
  if (isStop(flags)) {
    return flags;
  }

  if (flags.booleans.has("oauth") && flags.booleans.has("device")) {
    return usageError(
      "login accepts only one of --oauth and --device",
      "use --oauth on a machine with a browser, --device on a headless one",
    );
  }

  const provider = providerFlag(flags, "auth add");
  if ("kind" in provider) {
    return provider;
  }

  const account = flags.values.get("account");
  const label = flags.values.get("label");
  const secretFile = flags.values.get("secret-file");

  return {
    kind: "login",
    options: {
      provider: provider.provider,
      ...(flags.booleans.has("project") ? { project: true } : {}),
      ...(flags.booleans.has("oauth") ? { oauth: true } : {}),
      ...(flags.booleans.has("device") ? { device: true } : {}),
      ...(account === undefined ? {} : { account }),
      ...(label === undefined ? {} : { label }),
      ...(secretFile === undefined ? {} : { secretFile }),
    },
  };
}

export function parseLogout(argv: ReadonlyArray<string>): ParsedCommand {
  const flags = parseAuthFlags(argv);
  if (isStop(flags)) {
    return flags;
  }

  const provider = providerFlag(flags, "logout");
  if ("kind" in provider) {
    return provider;
  }

  // logout clears the family's current pointer and has no account to name:
  // an --account here used to vanish silently while reporting success (#15).
  const account = flags.values.get("account");
  if (account !== undefined) {
    return usageError(
      "logout does not accept --account",
      "logout clears the current account; to remove a stored secret use `trylo auth delete --provider <id> --account <id>`",
    );
  }

  return {
    kind: "logout",
    options: {
      provider: provider.provider,
      ...(flags.booleans.has("project") ? { project: true } : {}),
    },
  };
}

export function parseAuthStatus(argv: ReadonlyArray<string>): ParsedCommand {
  const accepted = ["--json", "--help", "-h"];
  const unexpectedToken = firstUnexpected(argv, accepted);
  if (unexpectedToken !== undefined) {
    return usageError(
      `status does not accept ${unexpectedToken}`,
      "try `trylo status` or `trylo status --json`",
    );
  }

  return { kind: "auth_status", json: argv.includes("--json") };
}

export function parseAuthList(argv: ReadonlyArray<string>): ParsedCommand {
  const accepted = ["--json", "--project", "--help", "-h"];
  const unexpectedToken = firstUnexpected(argv, accepted);
  if (unexpectedToken !== undefined) {
    return usageError(
      `auth list does not accept ${unexpectedToken}`,
      "try `trylo auth list` or `trylo auth list --project`",
    );
  }

  return { kind: "auth_list", json: argv.includes("--json"), project: argv.includes("--project") };
}

export function parseAuthSwitch(argv: ReadonlyArray<string>): ParsedCommand {
  const flags = parseAuthFlags(argv);
  if (isStop(flags)) {
    return flags;
  }

  const provider = providerFlag(flags, "auth switch");
  if ("kind" in provider) {
    return provider;
  }

  const account = flags.values.get("account");
  if (account === undefined) {
    return usageError(
      "auth switch requires --account <id>",
      "run `trylo auth list` to see the stored account ids",
    );
  }

  return {
    kind: "auth_switch",
    options: {
      provider: provider.provider,
      account,
      ...(flags.booleans.has("project") ? { project: true } : {}),
    },
  };
}

export function parseAuthDelete(argv: ReadonlyArray<string>): ParsedCommand {
  const flags = parseAuthFlags(argv);
  if (isStop(flags)) {
    return flags;
  }

  const provider = providerFlag(flags, "auth delete");
  if ("kind" in provider) {
    return provider;
  }

  const account = flags.values.get("account");
  if (account === undefined) {
    return usageError(
      "auth delete requires --account <id>",
      "run `trylo auth list` to see the stored account ids",
    );
  }

  return {
    kind: "auth_delete",
    options: {
      provider: provider.provider,
      account,
      ...(flags.booleans.has("project") ? { project: true } : {}),
    },
  };
}
