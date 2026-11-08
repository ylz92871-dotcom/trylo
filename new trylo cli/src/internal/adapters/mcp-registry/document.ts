import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import {
  MCP_FORBIDDEN_ENTRY_KEYS,
  MCP_REGISTRY_FORMAT_VERSION,
  type McpRegistryFailure,
  type McpServerEntry,
} from "../../ports/mcp-registry.js";
import { validateArgs, validateEnv, validateHeaders, validateRemoteUrl } from "./validate.js";

/**
 * The registry document, read and written strictly.
 *
 * Shape, verbatim:
 *
 * ```json
 * {
 *   "formatVersion": 1,
 *   "checksum": "<sha256 of the entries array, canonical JSON>",
 *   "servers": [
 *     { "name": "fs", "transport": "stdio", "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem"],
 *       "env": { "TOKEN": "..." }, "enabled": true }
 *   ]
 * }
 * ```
 *
 * `checksum` covers **only `servers`**, deliberately. It detects bit rot and a
 * half-finished write; it is not a signature and this module does not pretend
 * otherwise — the file lives in a directory the user controls, so anything that
 * can rewrite the entries can rewrite the checksum too.
 *
 * The reader's stance is the whole point of this file. Three cases are treated
 * as *failures*, never as "empty":
 *
 *  - unknown or missing `formatVersion` — a newer writer's file may mean
 *    something different, and reading it optimistically would silently drop
 *    fields this version cannot express;
 *  - any key the schema does not define — at the document level and inside an
 *    entry. An unknown key is how a config smuggles in a `url`, an `inheritEnv`
 *    or a future `autoApprove`;
 *  - a checksum that does not match.
 *
 * A broken file must never be reported as "you have no servers", because the
 * user's next action (re-adding them) would then silently clobber whatever the
 * file really said.
 */

export type RegistryDocument = {
  readonly formatVersion: number;
  readonly checksum: string;
  readonly servers: ReadonlyArray<McpServerEntry>;
};

const DOCUMENT_KEYS: ReadonlySet<string> = new Set(["formatVersion", "checksum", "servers"]);
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  "name",
  "transport",
  "command",
  "args",
  "env",
  "enabled",
  "url",
  "headers",
]);

/**
 * Canonical JSON for the checksum: keys sorted at every level, no whitespace.
 * The same routine must produce the same bytes on both the write and the read
 * path, or every file would appear corrupt.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * One entry as it is written to disk. A stdio entry keeps the B-wave shape
 * verbatim; a remote entry stores only its remote fields — `command`, `args`
 * and `env` are omitted so the document never claims a server that is both
 * things at once. `headers` is omitted when empty, so `{}` and "absent" round
 * -trip to the same bytes.
 */
function entryToJson(entry: McpServerEntry): JsonValue {
  if (entry.transport === "stdio") {
    return {
      name: entry.name,
      transport: entry.transport,
      command: entry.command,
      args: [...entry.args],
      env: { ...entry.env },
      enabled: entry.enabled,
    };
  }

  const hasHeaders = entry.headers !== undefined && Object.keys(entry.headers).length > 0;

  return {
    name: entry.name,
    transport: entry.transport,
    url: entry.url ?? "",
    ...(hasHeaders ? { headers: { ...entry.headers } } : {}),
    enabled: entry.enabled,
  };
}

function entriesToJson(servers: ReadonlyArray<McpServerEntry>): JsonValue {
  return servers.map(entryToJson);
}

export function checksumFor(servers: ReadonlyArray<McpServerEntry>): string {
  return createHash("sha256").update(canonicalJson(entriesToJson(servers)), "utf8").digest("hex");
}

export function encodeDocument(servers: ReadonlyArray<McpServerEntry>): string {
  const document: JsonObject = {
    formatVersion: MCP_REGISTRY_FORMAT_VERSION,
    checksum: checksumFor(servers),
    servers: entriesToJson(servers),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function decodeFailure(code: McpRegistryFailure["code"], detail: string): McpRegistryFailure {
  return { ok: false, code, detail };
}

/**
 * Parses a document. Pure: no I/O, so every hostile shape is a unit test.
 *
 * `source` names the file in failure details — a user with two scopes needs to
 * know which one is broken.
 */
export function decodeDocument(
  raw: string,
  source: string,
): { readonly ok: true; readonly value: RegistryDocument } | McpRegistryFailure {
  let parsed: JsonValue;

  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    return decodeFailure("invalid_document", `${source}: not valid JSON`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return decodeFailure("invalid_document", `${source}: document is not an object`);
  }

  const document = parsed as Readonly<Record<string, JsonValue>>;

  for (const key of Object.keys(document)) {
    if (!DOCUMENT_KEYS.has(key)) {
      return decodeFailure("unknown_key", `${source}: unknown top-level key ${JSON.stringify(key)}`);
    }
  }

  const version = document["formatVersion"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return decodeFailure("invalid_document", `${source}: formatVersion must be an integer`);
  }

  if (version !== MCP_REGISTRY_FORMAT_VERSION) {
    return decodeFailure(
      "unknown_format_version",
      `${source}: formatVersion ${version} is not supported (this build reads ${MCP_REGISTRY_FORMAT_VERSION})`,
    );
  }

  const rawServers = document["servers"];
  if (!Array.isArray(rawServers)) {
    return decodeFailure("invalid_document", `${source}: servers must be an array`);
  }

  const servers: McpServerEntry[] = [];

  for (let index = 0; index < rawServers.length; index += 1) {
    const entry = decodeEntry(rawServers[index], source, index);
    if (!entry.ok) {
      return entry;
    }
    servers.push(entry.value);
  }

  const checksum = document["checksum"];
  if (typeof checksum !== "string") {
    return decodeFailure("invalid_document", `${source}: checksum must be a string`);
  }

  if (checksum !== checksumFor(servers)) {
    return decodeFailure(
      "checksum_mismatch",
      `${source}: checksum does not match the entries; the file was edited or truncated outside Trylo`,
    );
  }

  return { ok: true, value: { formatVersion: version, checksum, servers } };
}

function decodeEntry(
  raw: JsonValue | undefined,
  source: string,
  index: number,
): { readonly ok: true; readonly value: McpServerEntry } | McpRegistryFailure {
  const at = `${source}: servers[${index}]`;

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return decodeFailure("invalid_document", `${at} is not an object`);
  }

  const entry = raw as Readonly<Record<string, JsonValue>>;

  for (const key of Object.keys(entry)) {
    // Keys that are never legal in any shape this build can represent.
    if (MCP_FORBIDDEN_ENTRY_KEYS.has(key)) {
      return decodeFailure("unsupported_transport", `${at}: key ${JSON.stringify(key)} is not supported`);
    }
    if (!ENTRY_KEYS.has(key)) {
      return decodeFailure("unknown_key", `${at}: unknown key ${JSON.stringify(key)}`);
    }
  }

  const name = entry["name"];
  if (typeof name !== "string") {
    return decodeFailure("invalid_name", `${at}: name must be a string`);
  }

  const transport = entry["transport"];
  if (typeof transport !== "string" || (transport !== "stdio" && transport !== "http" && transport !== "sse")) {
    return decodeFailure(
      "unsupported_transport",
      `${at}: transport must be one of stdio, http, sse; got ${JSON.stringify(transport)}`,
    );
  }

  return transport === "stdio"
    ? decodeStdioEntry(entry, name, at)
    : decodeRemoteEntry(entry, name, transport, at);
}

/** The B-wave stdio shape, read exactly as before: url/headers keys refused. */
function decodeStdioEntry(
  entry: Readonly<Record<string, JsonValue>>,
  name: string,
  at: string,
): { readonly ok: true; readonly value: McpServerEntry } | McpRegistryFailure {
  // A url or headers key on a stdio entry is a shape the writer must never
  // have produced, and "I configured a url and Trylo ignored it" is a mistake
  // worth naming precisely.
  if ("url" in entry || "headers" in entry) {
    return decodeFailure(
      "unsupported_transport",
      `${at}: url/headers are not valid on a stdio entry`,
    );
  }

  const argsFailure = validateArgs(entry["args"]);
  if (argsFailure !== undefined) {
    return decodeFailure(argsFailure.code, `${at}: ${argsFailure.detail}`);
  }

  const envFailure = validateEnv(entry["env"]);
  if (envFailure !== undefined) {
    return decodeFailure(envFailure.code, `${at}: ${envFailure.detail}`);
  }

  const command = entry["command"];
  if (typeof command !== "string" || command.length === 0) {
    return decodeFailure("invalid_command", `${at}: command must be a non-empty string`);
  }

  const enabled = entry["enabled"];
  if (typeof enabled !== "boolean") {
    return decodeFailure("invalid_enabled", `${at}: enabled must be a boolean`);
  }

  return {
    ok: true,
    value: {
      name,
      transport: "stdio",
      command,
      args: [...(entry["args"] as ReadonlyArray<string>)],
      env: { ...(entry["env"] as Readonly<Record<string, string>>) },
      enabled,
    },
  };
}

/**
 * A remote entry carries `url` (mandatory, http/https) and optionally
 * `headers`, and never the stdio fields — a document that holds both is not
 * one server, so every misplaced stdio key is named by its own failure code.
 */
function decodeRemoteEntry(
  entry: Readonly<Record<string, JsonValue>>,
  name: string,
  transport: "http" | "sse",
  at: string,
): { readonly ok: true; readonly value: McpServerEntry } | McpRegistryFailure {
  if ("command" in entry) {
    return decodeFailure("invalid_command", `${at}: command only applies to stdio entries`);
  }

  if ("args" in entry) {
    return decodeFailure("invalid_args", `${at}: args only apply to stdio entries`);
  }

  if ("env" in entry) {
    return decodeFailure("invalid_env", `${at}: env only applies to stdio entries`);
  }

  const urlFailure = validateRemoteUrl(entry["url"]);
  if (urlFailure !== undefined) {
    return decodeFailure(urlFailure.code, `${at}: ${urlFailure.detail}`);
  }

  const headers = entry["headers"] ?? {};
  const headersFailure = validateHeaders(headers);
  if (headersFailure !== undefined) {
    return decodeFailure(headersFailure.code, `${at}: ${headersFailure.detail}`);
  }

  const enabled = entry["enabled"];
  if (typeof enabled !== "boolean") {
    return decodeFailure("invalid_enabled", `${at}: enabled must be a boolean`);
  }

  const headerRecord = headers as Readonly<Record<string, string>>;

  return {
    ok: true,
    value: {
      name,
      transport,
      command: "",
      args: [],
      env: {},
      enabled,
      url: entry["url"] as string,
      ...(Object.keys(headerRecord).length > 0 ? { headers: headerRecord } : {}),
    },
  };
}

/** An empty, well-formed document. The only way a registry starts life. */
export function emptyDocument(): RegistryDocument {
  return {
    formatVersion: MCP_REGISTRY_FORMAT_VERSION,
    checksum: checksumFor([]),
    servers: [],
  };
}
