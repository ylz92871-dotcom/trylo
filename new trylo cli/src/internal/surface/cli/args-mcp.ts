import {
  isMcpScope,
  isMcpServerName,
  type McpScope,
  type McpRegistryTransport,
} from "../../ports/mcp-registry.js";
import { flagToken, readValue, usageError } from "./args-tokens.js";
import type { ParsedCommand } from "./args-primitives.js";
import { familyHelpCommand } from "./usage.js";
import { readAddFlags, type AddFlags } from "./args-mcp-add-flags.js";

/**
 * `mcp` argument parsing.
 *
 * A new file rather than a longer `if` chain in `args.ts`, following the
 * `args-auth.ts` / `args-run.ts` family split: the `mcp` family is the only one
 * that takes a `--` separator, so its token shape is genuinely its own.
 *
 * Pure: no IO, no process. Everything the command layer needs is in the parsed
 * result, including the refusals. Since the remote-transport ADR
 * (2026-09-16-ADR-MCP远端传输.md) there are *two* registration paths and they
 * are mutually exclusive, exactly as the three reference CLIs do it
 * (codex `ArgGroup`, opencode `!!args.url === !!command.length`):
 *
 *   trylo mcp add <name> -- <command> [args...]            (stdio)
 *   trylo mcp add <name> --url <url> [--header "N: V"]     (remote)
 *
 * Giving both is a usage error, not "the last one wins" — a registry entry
 * that is half of each describes no server at all.
 */

export type McpAddCommandOptions = {
  readonly name: string;
  readonly transport: McpRegistryTransport;
  /** stdio entries only: the command after `--`. */
  readonly command: string;
  /** stdio entries only. Everything after the command. Never shell-interpreted. */
  readonly args: ReadonlyArray<string>;
  /** stdio entries only. */
  readonly env: Readonly<Record<string, string>>;
  /** remote entries only. */
  readonly url?: string;
  /** remote entries only. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly scope: McpScope;
  /** `--disable` writes the entry already switched off. */
  readonly enabled: boolean;
};

export type McpTargetOptions = {
  readonly name: string;
  readonly scope: McpScope;
};

export const ADD_HINT =
  "try `trylo mcp add <name> -- <command> [args...]` or `trylo mcp add <name> --url <url>`";
const TARGET_HINT = "try `trylo mcp remove <name> --scope user|project`";

/**
 * Flags the non-add `mcp` verbs refuse. None of them changes how an *existing*
 * server connects, so none of them belongs to remove/enable/disable; each gets
 * its own message so the answer explains the boundary instead of just failing.
 */
export const REFUSED_FLAGS: Readonly<Record<string, string>> = {
  url: "mcp remove|enable|disable does not accept --url: only `mcp add` registers a server",
  transport: "mcp remove|enable|disable does not accept --transport: only `mcp add` registers a server",
  header: "mcp remove|enable|disable does not accept --header: only `mcp add` registers a server",
  headers: "mcp remove|enable|disable does not accept --headers: only `mcp add` registers a server",
  "inherit-env": "mcp does not accept --inherit-env: the process environment is never inherited wholesale",
};

export function refusedFlag(name: string): string | undefined {
  return REFUSED_FLAGS[name];
}

export function parseMcp(argv: ReadonlyArray<string>): ParsedCommand {
  const sub = argv[0];
  if (sub === "--help" || sub === "-h") return familyHelpCommand("mcp");

  if (sub === undefined) {
    return usageError("mcp requires a subcommand", "try `trylo mcp list`");
  }

  if (sub === "add") {
    return parseMcpAdd(argv.slice(1));
  }

  if (sub === "list") {
    return parseMcpList(argv.slice(1));
  }

  if (sub === "status") {
    return parseMcpJsonOnly(argv.slice(1), "status");
  }

  if (sub === "remove") {
    return parseMcpTarget(argv.slice(1), "remove");
  }

  if (sub === "enable") {
    return parseMcpTarget(argv.slice(1), "enable", true);
  }

  if (sub === "disable") {
    return parseMcpTarget(argv.slice(1), "disable", false);
  }

  return usageError(
    `unknown mcp subcommand: ${sub}`,
    "try `trylo mcp add|list|remove|enable|disable`",
  );
}

function parseMcpList(argv: ReadonlyArray<string>): ParsedCommand {
  return parseMcpJsonOnly(argv, "list");
}

/**
 * `status` takes the same single switch as `list` and nothing else.
 *
 * The two share the walk rather than each having their own: a subcommand whose
 * only option is `--json` has one shape, and two copies of that loop is how
 * `status` ends up accepting a flag `list` refuses.
 */
function parseMcpJsonOnly(argv: ReadonlyArray<string>, sub: "list" | "status"): ParsedCommand {
  let json = false;

  for (const token of argv) {
    if (token === "--help" || token === "-h") return familyHelpCommand("mcp");
    if (token === "--json") {
      json = true;
      continue;
    }
    return usageError(`mcp ${sub} does not accept ${token}`, `try \`trylo mcp ${sub} --json\``);
  }

  return sub === "status" ? { kind: "mcp_status", json } : { kind: "mcp_list", json };
}

/**
 * `add <name> [options] (--url <url> | -- <command> [args...])`.
 *
 * The `--` is mandatory for the stdio path: without it a server whose first
 * argument happens to start with `--` would be indistinguishable from an
 * option of `add` itself. The remote path needs no separator, which is why
 * "both given" must be an explicit refusal rather than a parse accident.
 */
function parseMcpAdd(argv: ReadonlyArray<string>): ParsedCommand {
  const name = argv[0];
  if (name === "--help" || name === "-h") return familyHelpCommand("mcp");

  if (name === undefined || name.startsWith("--")) {
    return usageError("mcp add requires a server name", ADD_HINT);
  }

  if (!isMcpServerName(name)) {
    // Checked here as well as by the registry: a name that cannot be legal is a
    // typing mistake, and the parse layer is where a typing mistake belongs.
    return usageError(`server name must match [a-z0-9][a-z0-9_-]{0,63}; got ${JSON.stringify(name)}`, ADD_HINT);
  }

  const separator = argv.indexOf("--", 1);
  const flags: AddFlags = { scope: "user", enabled: true, env: {}, headers: {}, url: undefined, transport: undefined };
  const flagError = readAddFlags(argv, separator, flags);
  if (flagError !== undefined) {
    return flagError;
  }

  return assembleAdd(name, argv, separator, flags);
}

/**
 * Cross-field rules: exactly one registration path, `--transport` consistent
 * with it, and each field family on the transport that can carry it.
 */
function assembleAdd(
  name: string,
  argv: ReadonlyArray<string>,
  separator: number,
  flags: AddFlags,
): ParsedCommand {
  const url = flags.url;
  const remote = url !== undefined;
  if (remote && separator >= 0) {
    return usageError(
      "give either --url or a command after `--`, not both: a server is registered through one transport",
      ADD_HINT,
    );
  }

  if (!remote && separator < 0) {
    return usageError("mcp add requires `--` before the server command, or --url <url> for a remote server", ADD_HINT);
  }

  if (flags.transport !== undefined && remote !== (flags.transport !== "stdio")) {
    return usageError(
      `--transport ${flags.transport} conflicts with ${remote ? "--url" : "the command after `--`"}`,
      ADD_HINT,
    );
  }

  const transport: McpRegistryTransport = remote ? (flags.transport ?? "http") : "stdio";

  if (remote && Object.keys(flags.env).length > 0) {
    return usageError("--env only applies to stdio servers; remote servers take --header", ADD_HINT);
  }

  if (!remote && Object.keys(flags.headers).length > 0) {
    return usageError("--header only applies to remote servers; stdio servers take --env KEY=VALUE", ADD_HINT);
  }

  if (url !== undefined) {
    return {
      kind: "mcp_add",
      options: {
        name,
        transport,
        command: "",
        args: [],
        env: {},
        ...(Object.keys(flags.headers).length > 0 ? { headers: { ...flags.headers } } : {}),
        url,
        scope: flags.scope,
        enabled: flags.enabled,
      },
    };
  }

  const commandTokens = argv.slice(separator + 1);
  const command = commandTokens[0];
  if (command === undefined) {
    return usageError("mcp add requires a command after `--`", ADD_HINT);
  }

  return {
    kind: "mcp_add",
    options: {
      name,
      transport,
      command,
      args: commandTokens.slice(1),
      env: { ...flags.env },
      scope: flags.scope,
      enabled: flags.enabled,
    },
  };
}

/**
 * `remove|enable|disable <name> [--scope user|project]`.
 *
 * `--scope` is required by the rules, not by the parser: omitting it targets the
 * user registry, which is why a project-scoped `remove` can never delete a user
 * entry by accident.
 */
function parseMcpTarget(
  argv: ReadonlyArray<string>,
  sub: "remove" | "enable" | "disable",
  enabled?: boolean,
): ParsedCommand {
  const name = argv[0];
  if (name === "--help" || name === "-h") return familyHelpCommand("mcp");

  if (name === undefined || name.startsWith("--")) {
    return usageError(`mcp ${sub} requires a server name`, TARGET_HINT);
  }

  if (!isMcpServerName(name)) {
    return usageError(
      `server name must match [a-z0-9][a-z0-9_-]{0,63}; got ${JSON.stringify(name)}`,
      TARGET_HINT,
    );
  }

  let scope: McpScope = "user";
  let index = 1;

  while (index < argv.length) {
    const token = argv[index];
    const flag = token === undefined ? undefined : flagToken(token);
    if (flag === undefined) {
      return usageError(`mcp ${sub} does not accept ${token ?? ""}`, TARGET_HINT);
    }

    const refusal = refusedFlag(flag.name);
    if (refusal !== undefined) {
      return usageError(refusal, TARGET_HINT);
    }

    if (flag.name !== "scope") {
      return usageError(`mcp ${sub} does not accept --${flag.name}`, TARGET_HINT);
    }

    const read = readValue(argv, index, flag.inlineValue);
    if (read.error !== undefined || read.value === undefined) {
      return usageError("--scope needs a value", TARGET_HINT);
    }

    if (!isMcpScope(read.value)) {
      return usageError(`--scope must be one of user, project; got ${read.value}`, TARGET_HINT);
    }

    scope = read.value;
    index = read.next;
  }

  if (enabled === undefined) {
    return { kind: "mcp_remove", options: { name, scope } };
  }

  return { kind: "mcp_set_enabled", options: { name, scope }, enabled };
}
