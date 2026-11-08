/**
 * Reading the language-server file the `lspConfigFile` setting names (WP12 L60).
 *
 * This is the one place a settings path becomes programs, so it is also the
 * one place a malformed file is refused. Unknown keys, duplicate names and
 * extensions claimed twice all fail closed with a named reason: the pool
 * would refuse shared extensions at query time, but by then the person has
 * already waited for a failure that was knowable at load.
 *
 * A file that cannot be read is a *returned* failure, not a throw. The caller
 * (run-one-turn) warns and continues without servers, the roles precedent: a
 * broken auxiliary file must not kill an unrelated coding turn, but it must
 * never silently become a different configuration either.
 */

import type { LspServerConfig } from "../../adapters/language-server/registry.js";

export const LSP_CONFIG_MAX_SERVERS = 16;

export type LspConfigFailureCode = "lsp_config_unreadable" | "lsp_config_invalid";

type ConfigRefusal = { readonly ok: false; readonly code: LspConfigFailureCode; readonly message: string };

export type LspConfigLoadResult =
  | { readonly ok: true; readonly servers: ReadonlyArray<LspServerConfig> }
  | ConfigRefusal;

type ReadFile = (path: string) => string | undefined;

const KNOWN_KEYS = new Set(["name", "command", "args", "extensions", "env", "enabled", "origin"]);

export function loadLspServersFile(readFile: ReadFile, path: string): LspConfigLoadResult {
  let text: string | undefined;

  try {
    text = readFile(path);
  } catch (error) {
    return {
      ok: false,
      code: "lsp_config_unreadable",
      message: `cannot read language server file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (text === undefined) {
    return {
      ok: false,
      code: "lsp_config_unreadable",
      message: `cannot read language server file ${path}: no such file`,
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return invalid(path, `is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid(path, "must be an object with a servers array");
  }

  const servers = (parsed as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) {
    return invalid(path, "must be an object with a servers array");
  }

  if (servers.length > LSP_CONFIG_MAX_SERVERS) {
    return invalid(path, `lists ${servers.length} servers, the maximum is ${LSP_CONFIG_MAX_SERVERS}`);
  }

  const loaded: Array<LspServerConfig> = [];
  const names = new Set<string>();
  const extensions = new Map<string, string>();

  for (const entry of servers) {
    const server = readServer(entry, path);
    if (!server.ok) {
      return server;
    }

    if (names.has(server.config.serverName)) {
      return invalid(path, `names the server ${server.config.serverName} twice`);
    }

    names.add(server.config.serverName);

    for (const extension of server.config.extensions) {
      const owner = extensions.get(extension);
      if (owner !== undefined) {
        return invalid(path, `.${extension} is claimed by both ${owner} and ${server.config.serverName}; configure exactly one`);
      }
      extensions.set(extension, server.config.serverName);
    }

    loaded.push(server.config);
  }

  return { ok: true, servers: loaded };
}

function invalid(path: string, reason: string): ConfigRefusal {
  return { ok: false, code: "lsp_config_invalid", message: `language server file ${path} ${reason}` };
}

type ServerRead =
  | { readonly ok: true; readonly config: LspServerConfig }
  | ConfigRefusal;

function readServer(entry: unknown, path: string): ServerRead {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return invalid(path, "holds a server entry that is not an object");
  }

  const record = entry as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      return invalid(path, `holds an unknown key ${JSON.stringify(key)}; refusing rather than ignoring a possible typo`);
    }
  }

  const name = record["name"];
  const command = record["command"];

  if (typeof name !== "string" || name.length === 0) {
    return invalid(path, "holds a server with no usable name");
  }

  if (typeof command !== "string" || command.length === 0) {
    return invalid(path, `server ${name} has no usable command`);
  }

  const args = readStringArray(record["args"]);
  if (args === undefined) {
    return invalid(path, `server ${name} args must be an array of strings`);
  }

  const extensions = readStringArray(record["extensions"]);
  if (extensions === undefined || extensions.length === 0) {
    return invalid(path, `server ${name} needs at least one extension`);
  }

  for (const extension of extensions) {
    if (!/^[a-z0-9]+$/.test(extension)) {
      return invalid(path, `server ${name} extension ${JSON.stringify(extension)} must be lower-case with no dot`);
    }
  }

  const env = readStringRecord(record["env"]);
  if (record["env"] !== undefined && env === undefined) {
    return invalid(path, `server ${name} env must be an object of strings`);
  }

  const enabled = record["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return invalid(path, `server ${name} enabled must be a boolean`);
  }

  const origin = record["origin"];
  if (origin !== undefined && typeof origin !== "string") {
    return invalid(path, `server ${name} origin must be a string`);
  }

  return {
    ok: true,
    config: {
      serverName: name,
      command,
      args,
      extensions,
      ...(env === undefined ? {} : { env }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(origin === undefined ? {} : { origin }),
    },
  };
}

function readStringArray(value: unknown): ReadonlyArray<string> | undefined {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }

  return [...value] as ReadonlyArray<string>;
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const out: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      return undefined;
    }
    out[key] = entry;
  }

  return out;
}
