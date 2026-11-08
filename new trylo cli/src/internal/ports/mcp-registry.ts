import type { JsonObject } from "../protocol/envelope.js";

/**
 * MCP server registry port.
 *
 * A registry entry is *configuration*, not an installation. It records the
 * command a user asked Trylo to be able to run later; it never downloads
 * anything, never runs `npm install`, and never edits `PATH`. That separation
 * is what keeps `add` a pure shape check: a command whose binary does not exist
 * is still a legal entry, and the failure shows up at connect time where it can
 * be reported honestly.
 *
 * Two scopes exist, and they are *not* merged into one flat table:
 *
 *  - `user`    — one file shared by every project on the machine;
 *  - `project` — one file per workspace, meant to be version controlled.
 *
 * `list` merges them for display, and project wins on the fields a project is
 * allowed to override (see {@link McpEffectiveEntry}). The merge is a fact
 * about the *view*, not about the stored files: removing a registry entry is
 * always an explicit operation on one scope, and a project file can never
 * delete a user entry by omission.
 *
 * The registry is deliberately not an event log. There is no sequence number
 * and no append: a broken file is a broken file, and the reader fails closed
 * rather than interpreting a truncated document as "the user has no servers".
 */

/**
 * Transports this build can represent in the registry. `stdio` is a child
 * process; `http` is MCP Streamable HTTP (one endpoint, POST JSON-RPC); `sse`
 * is legacy HTTP+SSE (GET event stream, POST to the advertised endpoint).
 * An entry whose transport is in this list is *representable*; whether the
 * remote endpoint answers is a connect-time fact, exactly like a stdio binary
 * that does not exist yet.
 */
export const MCP_REGISTRY_TRANSPORTS = ["stdio", "http", "sse"] as const;

export type McpRegistryTransport = (typeof MCP_REGISTRY_TRANSPORTS)[number];

export const MCP_SCOPES = ["user", "project"] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/** The only document version this package can read or write. */
export const MCP_REGISTRY_FORMAT_VERSION = 1;

/**
 * Server ids are used verbatim inside tool names (`mcp__<id>__<tool>`), so the
 * character set is tight enough that a separator can never be ambiguous.
 */
export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The stored shape of one server. A `stdio` entry carries `command`/`args`/`env`
 * and never `url`/`headers`; a remote (`http`/`sse`) entry carries `url` (and
 * optionally `headers`) and stores no command — the in-memory type keeps the
 * fields at neutral empty values so existing readers keep compiling, but the
 * on-disk document omits them (see `adapters/mcp-registry/document.ts`).
 *
 * `command` is a literal string, not a resolved path: resolution happens at
 * connect time, on the machine that will run it.
 */
export type McpServerEntry = {
  readonly name: string;
  readonly transport: McpRegistryTransport;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Explicit keys only. The process environment is never inherited wholesale. */
  readonly env: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  /** Remote entries only. A URL the client will actually dial. */
  readonly url?: string;
  /**
   * Remote entries only. Secret-bearing values are allowed to be stored (the
   * registry file is user-controlled, like `env`), but never displayed: every
   * public view reduces `headers` to key names.
   */
  readonly headers?: Readonly<Record<string, string>>;
};

export type McpRegistryEntryLocation = {
  readonly name: string;
  readonly scope: McpScope;
};

/**
 * The result of merging user and project scopes for one server id.
 *
 * `overriddenBy` names the scope whose values won, so a caller can explain
 * "why is this server pointing somewhere else than I typed" without diffing
 * files. `enabled` and the transport fields are the project-overridable set.
 */
export type McpEffectiveEntry = {
  readonly entry: McpServerEntry;
  readonly scope: McpScope;
  readonly shadowedScopes: ReadonlyArray<McpScope>;
};

export type McpRegistryFailureCode =
  | "invalid_name"
  | "invalid_transport"
  | "unsupported_transport"
  | "invalid_command"
  | "invalid_args"
  | "invalid_env"
  | "invalid_url"
  | "invalid_headers"
  | "invalid_enabled"
  | "duplicate_entry"
  | "missing_entry"
  | "unknown_format_version"
  | "unknown_key"
  | "invalid_document"
  | "checksum_mismatch"
  | "read_failed"
  | "write_failed"
  | "lock_conflict"
  | "directory_unavailable";

export type McpRegistryFailure = {
  readonly ok: false;
  readonly code: McpRegistryFailureCode;
  readonly detail: string;
};

/** A separately verified runtime remains usable when the base view is unreadable. */
export type McpRegistryDiagnostic = {
  readonly source: "base";
  readonly coverage: "runtime_only";
  readonly code: McpRegistryFailureCode;
  /** Internal failure detail; public diagnostics expose the safe code only. */
  readonly detail: string;
};

export type McpRegistryOk<T> = {
  readonly ok: true;
  readonly value: T;
  readonly diagnostics?: ReadonlyArray<McpRegistryDiagnostic>;
};

export type McpRegistryResult<T> = McpRegistryOk<T> | McpRegistryFailure;

export type McpAddInput = {
  readonly name: string;
  readonly transport: McpRegistryTransport;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly scope: McpScope;
  /** Remote entries only; see `McpServerEntry`. */
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

/**
 * The public view of an entry. `env` is deliberately reduced to its key names,
 * and `headers` to `headerKeys`, for the same reason: a listing is the most
 * likely thing to be pasted into a bug report, and a header value may be a
 * bearer token. Keys are still reported so a user can see a server is
 * configured without seeing what it holds. Remote entries additionally show
 * their `url`, which is configuration, not a secret.
 */
export type McpServerPublicView = {
  readonly name: string;
  readonly transport: McpRegistryTransport;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly envKeys: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly scopes: ReadonlyArray<McpScope>;
  /** Remote entries only. */
  readonly url?: string;
  /** Header *names* only, sorted; values never leave the store. */
  readonly headerKeys: ReadonlyArray<string>;
};

export type McpRegistryView = {
  readonly formatVersion: number;
  readonly servers: ReadonlyArray<McpServerPublicView>;
};

export type McpRegistryScopeView = {
  readonly scope: McpScope;
  readonly formatVersion: number;
  readonly servers: ReadonlyArray<McpServerEntry>;
};

export type McpRegistryPort = {
  /** Fails when an entry with the same name already exists in that scope. */
  add(input: McpAddInput): Promise<McpRegistryResult<McpServerEntry>>;
  remove(location: McpRegistryEntryLocation): Promise<McpRegistryResult<McpServerEntry>>;
  setEnabled(location: McpRegistryEntryLocation, enabled: boolean): Promise<McpRegistryResult<McpServerEntry>>;
  /** Entries of exactly one scope, as stored. */
  listScope(scope: McpScope): Promise<McpRegistryResult<McpRegistryScopeView>>;
  /** Entries of one scope with env values present. Not for display. */
  /** Merged, project-over-user view with env values redacted to key names. */
  list(): Promise<McpRegistryResult<McpRegistryView>>;
  /** Merged entries with env values, for the connect path. */
  resolve(name: string): Promise<McpRegistryResult<McpEffectiveEntry>>;
  /** Every server id known to either scope, deduplicated and sorted. */
  names(): Promise<McpRegistryResult<ReadonlyArray<string>>>;
};

// ---------------------------------------------------------------------------
// Pure predicates and constants. The entry shape-checks that return a
// `McpRegistryFailure` live in `adapters/mcp-registry/validate.ts`, beside the
// two callers (the store's write path and the document's read path), so this
// port stays types, constants and one-line predicates.
// ---------------------------------------------------------------------------

export function isMcpScope(value: string): value is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(value);
}

export function isMcpServerName(value: string): boolean {
  return MCP_SERVER_NAME_PATTERN.test(value);
}

/**
 * Keys that have no meaning in any entry shape this build can represent, so
 * their presence is always a smuggling attempt. `url` and `headers` used to be
 * here when this build was stdio-only; they are now schema keys for remote
 * entries, and a *stdio* entry carrying them is refused as an unsupported
 * transport at the shape check instead.
 */
export const MCP_FORBIDDEN_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "transport_url",
  "inheritEnv",
]);

/** True when the transport names something this build can represent. */
export function isMcpRegistryTransport(value: string): value is McpRegistryTransport {
  return (MCP_REGISTRY_TRANSPORTS as readonly string[]).includes(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
