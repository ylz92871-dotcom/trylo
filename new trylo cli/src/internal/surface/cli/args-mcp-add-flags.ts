import { isMcpRegistryTransport, isMcpScope, MCP_REGISTRY_TRANSPORTS, type McpRegistryTransport, type McpScope } from "../../ports/mcp-registry.js";
import { flagToken, readValue, usageError } from "./args-tokens.js";
import type { ParsedCommand } from "./args-primitives.js";
import { ADD_HINT, REFUSED_FLAGS } from "./args-mcp.js";

/**
 * The flags of `mcp add`, walked one at a time.
 *
 * Split out of `args-mcp.ts` for the reason the file limit exists: `add` has the
 * most flags of any subcommand, and keeping the walk next to the cross-field
 * rules in one file pushed it past the ceiling for no reason — they are two
 * different passes over the same input and read better apart.
 *
 * `assembleAdd` stays in the parent because it decides *whether* a combination
 * is legal, which is a question about the whole command rather than about one
 * flag. Nothing here validates anything across fields; every refusal below is
 * about a single value.
 *
 * Pure: no IO, no process. A malformed flag dies here as a usage error with a
 * hint, never later as a registry error the user cannot act on.
 */

/**
 * State accumulated across the flag walk, before cross-field rules run.
 * Kept in one type so the two passes (flags, then consistency) stay readable.
 */
export type AddFlags = {
  scope: McpScope;
  enabled: boolean;
  env: Record<string, string>;
  headers: Record<string, string>;
  url: string | undefined;
  transport: McpRegistryTransport | undefined;
};

/** Walks the flags before the separator (or the end, on the remote path). */
export function readAddFlags(
  argv: ReadonlyArray<string>,
  separator: number,
  flags: AddFlags,
): ParsedCommand | undefined {
  const limit = separator < 0 ? argv.length : separator;
  let index = 1;

  while (index < limit) {
    const token = argv[index];
    const flag = token === undefined ? undefined : flagToken(token);
    if (flag === undefined) {
      // A bare token where a flag belongs: on the stdio path that used to mean
      // "the `--` is missing", and that reading still explains it best.
      if (separator < 0) {
        return usageError(
          "mcp add requires `--` before the server command, or --url <url> for a remote server",
          ADD_HINT,
        );
      }
      return usageError(`mcp add does not accept ${token ?? ""}`, ADD_HINT);
    }

    if (flag.name === "inherit-env") {
      return usageError(REFUSED_FLAGS["inherit-env"] ?? "", ADD_HINT);
    }

    if (flag.name === "disable") {
      if (flag.inlineValue !== undefined) {
        return usageError("--disable takes no value", ADD_HINT);
      }
      flags.enabled = false;
      index += 1;
      continue;
    }

    const read = readValue(argv, index, flag.inlineValue);
    if (read.error !== undefined || read.value === undefined) {
      return usageError(`--${flag.name} needs a value`, ADD_HINT);
    }

    const applied = applyAddFlag(flags, flag.name, read.value);
    if (applied !== undefined) {
      return applied;
    }

    index = read.next;
  }

  return undefined;
}

/** Applies one recognized flag; an unrecognized one is a usage error. */
function applyAddFlag(flags: AddFlags, name: string, value: string): ParsedCommand | undefined {
  if (name === "scope") {
    if (!isMcpScope(value)) {
      return usageError(`--scope must be one of user, project; got ${value}`, ADD_HINT);
    }
    flags.scope = value;
    return undefined;
  }

  if (name === "env") {
    return applyEnvFlag(flags, value);
  }

  if (name === "url") {
    return applyUrlFlag(flags, value);
  }

  if (name === "transport") {
    return applyTransportFlag(flags, value);
  }

  if (name === "header" || name === "headers") {
    return applyHeaderFlag(flags, value);
  }

  return usageError(`mcp add does not accept --${name}`, ADD_HINT);
}

function applyEnvFlag(flags: AddFlags, value: string): ParsedCommand | undefined {
  const equalsAt = value.indexOf("=");
  if (equalsAt <= 0) {
    return usageError("--env requires KEY=VALUE", ADD_HINT);
  }
  flags.env[value.slice(0, equalsAt)] = value.slice(equalsAt + 1);
  return undefined;
}

/** URL syntax is checked here so a typo dies at parse time, not on dial. */
function applyUrlFlag(flags: AddFlags, value: string): ParsedCommand | undefined {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return usageError(`--url is not a valid URL: ${value}`, ADD_HINT);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return usageError(`--url must be http or https; got ${parsed.protocol}`, ADD_HINT);
  }

  flags.url = value;

  return undefined;
}

function applyTransportFlag(flags: AddFlags, value: string): ParsedCommand | undefined {
  if (!isMcpRegistryTransport(value)) {
    return usageError(
      `--transport must be one of ${MCP_REGISTRY_TRANSPORTS.join(", ")}; got ${value}`,
      ADD_HINT,
    );
  }

  flags.transport = value;

  return undefined;
}

/** `--header "Name: Value"`, split at the first colon (the opencode format). */
function applyHeaderFlag(flags: AddFlags, value: string): ParsedCommand | undefined {
  const colonAt = value.indexOf(":");
  if (colonAt <= 0) {
    return usageError('--header requires "Name: Value"', ADD_HINT);
  }

  const headerName = value.slice(0, colonAt).trim();
  if (headerName.length === 0) {
    return usageError('--header requires "Name: Value" with a non-empty name', ADD_HINT);
  }

  flags.headers[headerName] = value.slice(colonAt + 1).trim();

  return undefined;
}
