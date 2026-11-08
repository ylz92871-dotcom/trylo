import {
  isMcpRegistryTransport,
  isMcpServerName,
  MCP_REGISTRY_TRANSPORTS,
  type McpRegistryFailure,
  type McpScope,
  type McpServerEntry,
  type McpServerPublicView,
} from "../../ports/mcp-registry.js";

/**
 * Shared entry shape-checks and the display projection.
 *
 * These live beside the disk adapter rather than in the port so the port stays
 * types and constants: a shape `add` accepts must be exactly a shape the reader
 * will accept back, and both the store (write path) and the document decoder
 * (read path) call into here. Keeping one copy is what stops the two from
 * drifting into "the writer allowed what the reader rejects".
 */

/**
 * Arguments are a string array, never a shell string. A single command string
 * would force a shell into the spawn path, and `shell: true` is exactly the
 * thing this package refuses to hand a child process.
 */
export function validateArgs(value: unknown): McpRegistryFailure | undefined {
  if (!Array.isArray(value)) {
    return { ok: false, code: "invalid_args", detail: "args must be an array of strings" };
  }

  for (const item of value) {
    if (typeof item !== "string") {
      return { ok: false, code: "invalid_args", detail: "args must be an array of strings" };
    }
  }

  return undefined;
}

/**
 * Every env value must be a string, and no key may be empty. An empty key would
 * be unaddressable from the child's perspective, so it is a shape error rather
 * than something to silently drop.
 */
export function validateEnv(value: unknown): McpRegistryFailure | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "invalid_env", detail: "env must be an object of strings" };
  }

  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || typeof item !== "string") {
      return { ok: false, code: "invalid_env", detail: "env must be an object of strings" };
    }
  }

  return undefined;
}

/** Same string-map rules as `env`, under the headers-specific failure code. */
export function validateHeaders(value: unknown): McpRegistryFailure | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "invalid_headers", detail: "headers must be an object of strings" };
  }

  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || typeof item !== "string") {
      return { ok: false, code: "invalid_headers", detail: "headers must be an object of strings" };
    }
  }

  return undefined;
}

const inputTransport = (input: { readonly transport: unknown }): McpRegistryFailure | undefined => {
  if (typeof input.transport !== "string" || !isMcpRegistryTransport(input.transport)) {
    return {
      ok: false,
      code: "unsupported_transport",
      detail: `transport must be one of ${MCP_REGISTRY_TRANSPORTS.join(", ")}; got ${JSON.stringify(input.transport)}`,
    };
  }
  return undefined;
};

const inputName = (name: unknown): McpRegistryFailure | undefined => {
  if (typeof name !== "string" || !isMcpServerName(name)) {
    return {
      ok: false,
      code: "invalid_name",
      detail: "name must match [a-z0-9][a-z0-9_-]{0,63}",
    };
  }
  return undefined;
};

/** `url` is only meaningful for a remote entry, and must be http/https. */
export function validateRemoteUrl(value: unknown): McpRegistryFailure | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, code: "invalid_url", detail: "url must be a non-empty string" };
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, code: "invalid_url", detail: `url is not a valid URL: ${JSON.stringify(value)}` };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      code: "invalid_url",
      detail: `url must be http or https; got ${parsed.protocol}`,
    };
  }

  return undefined;
}

/** Field-level cross-checks for a stdio entry: command exists, no remote keys. */
function validateStdioShape(input: {
  readonly command: unknown;
  readonly args: unknown;
  readonly env: unknown;
  readonly url?: unknown;
  readonly headers?: unknown;
}): McpRegistryFailure | undefined {
  if (input.url !== undefined) {
    return { ok: false, code: "invalid_url", detail: "url only applies to http/sse entries" };
  }

  if (input.headers !== undefined) {
    return { ok: false, code: "invalid_headers", detail: "headers only apply to http/sse entries" };
  }

  if (typeof input.command !== "string" || input.command.length === 0) {
    return { ok: false, code: "invalid_command", detail: "command must be a non-empty string" };
  }

  const argsFailure = validateArgs(input.args);
  if (argsFailure !== undefined) {
    return argsFailure;
  }

  const envFailure = validateEnv(input.env);
  if (envFailure !== undefined) {
    return envFailure;
  }

  return undefined;
}

/** Field-level cross-checks for a remote entry: a dialable url, no command
 * fields. `command`/`args`/`env` are required keys of the in-memory type, so a
 * remote add passes their neutral empties and anything non-empty is a shape
 * error rather than a field the reader would have to guess at.
 */
function validateRemoteShape(input: {
  readonly command: unknown;
  readonly args: unknown;
  readonly env: unknown;
  readonly url?: unknown;
  readonly headers?: unknown;
}): McpRegistryFailure | undefined {
  if (input.command !== "") {
    return { ok: false, code: "invalid_command", detail: "command only applies to stdio entries" };
  }

  if (Array.isArray(input.args) && input.args.length > 0) {
    return { ok: false, code: "invalid_args", detail: "args only apply to stdio entries" };
  }

  if (typeof input.env === "object" && input.env !== null && Object.keys(input.env).length > 0) {
    return { ok: false, code: "invalid_env", detail: "env only applies to stdio entries" };
  }

  const urlFailure = validateRemoteUrl(input.url);
  if (urlFailure !== undefined) {
    return urlFailure;
  }

  const headersFailure = validateHeaders(input.headers ?? {});
  if (headersFailure !== undefined) {
    return headersFailure;
  }

  return undefined;
}

/**
 * The one entry validator. It answers "is this a well-formed server entry",
 * which is a different question from "will it connect".
 */
export function validateEntryShape(input: {
  readonly name: unknown;
  readonly transport: unknown;
  readonly command: unknown;
  readonly args: unknown;
  readonly env: unknown;
  readonly enabled: unknown;
  readonly url?: unknown;
  readonly headers?: unknown;
}): McpRegistryFailure | undefined {
  const nameFailure = inputName(input.name);
  if (nameFailure !== undefined) {
    return nameFailure;
  }

  const transportFailure = inputTransport(input);
  if (transportFailure !== undefined) {
    return transportFailure;
  }

  const fieldFailure =
    input.transport === "stdio" ? validateStdioShape(input) : validateRemoteShape(input);
  if (fieldFailure !== undefined) {
    return fieldFailure;
  }

  if (typeof input.enabled !== "boolean") {
    return { ok: false, code: "invalid_enabled", detail: "enabled must be a boolean" };
  }

  return undefined;
}

/** Env and header values are dropped for display; the keys survive. */
export function publicViewOf(
  entry: McpServerEntry,
  scopes: ReadonlyArray<McpScope>,
): McpServerPublicView {
  return {
    name: entry.name,
    transport: entry.transport,
    command: entry.command,
    args: [...entry.args],
    envKeys: Object.keys(entry.env).sort(),
    enabled: entry.enabled,
    scopes: [...scopes],
    ...(entry.url === undefined ? {} : { url: entry.url }),
    headerKeys: Object.keys(entry.headers ?? {}).sort(),
  };
}
