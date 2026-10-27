import type { JsonValue } from "../protocol/envelope.js";
import type { SettingsFailure, SettingsValues } from "../ports/settings.js";

/**
 * The closed settings schema.
 *
 * "Closed" is the whole point: a key this module does not define is refused, so
 * a config file cannot smuggle in an `autoApprove`, an `inheritEnv` or a future
 * field this build does not understand. Fail-closed on the unknown is how a
 * loader stays honest across versions.
 *
 * Two families of keys are refused *by name* before the closed set is even
 * consulted, because they belong to other owners and must never reach the
 * resolved config:
 *
 *  - secrets (`apiKey`, `token`, `authorization`, anything containing `secret`)
 *    — the credentials package's job;
 *  - MCP declarations (`mcpServers`, `mcp`, `servers`) — the MCP registry's job.
 */

/** The only document version this package reads. Absent means 1. */
export const SETTINGS_FORMAT_VERSION = 1;

type KeySpec =
  | { readonly kind: "enum"; readonly members: ReadonlyArray<string> }
  | { readonly kind: "string" }
  | { readonly kind: "positiveInt" }
  | { readonly kind: "positiveSafeInt" }
  | { readonly kind: "positiveNumber" };

/**
 * The allowed keys and their value rules. `formatVersion` is *not* here: it is
 * document metadata handled by the parser, never a resolved config value.
 */
export const SETTINGS_SCHEMA: Readonly<Record<string, KeySpec>> = {
  // A *string*, not the shipped-id enum: `providers add` declares ids no schema
  // can enumerate, and a closed set here refused `--provider <declared-id>` in
  // its own config engine. Whether an id names a real provider is decided once,
  // against the profile, by the provider resolver.
  provider: { kind: "string" },
  model: { kind: "string" },
  // `endpoint` is a URL, not a credential. It is deliberately renderable in the
  // public view; the secret that authenticates against it is not stored here.
  endpoint: { kind: "string" },
  format: { kind: "enum", members: ["text", "stream-json"] },
  /**
   * Which interpreter, if any, reads a `run_shell` command string.
   *
   * An enum over shell NAMES and nothing else, for the reason WP05 measured
   * rather than chose: adding a `shell` property to the `run_shell` tool binding
   * changes its `parameters`, which changes `toolCatalogHash`, and
   * `session-open.ts:90` then refuses every session recorded before the change.
   * A run-level setting costs no session.
   *
   * Absent means no interpreter — the shipped default, and the property the rest
   * of the sandbox is built on: a `|` is a pipe this CLI builds and every other
   * operator is refused rather than interpreted. It is deliberately NOT in
   * `PACKAGED_DEFAULTS` for the same reason `contextTokenLimit` is not: unset is
   * meaningful, and a packaged value would hide it.
   */
  shell: { kind: "enum", members: ["bash", "zsh", "sh", "powershell", "cmd"] },
  maxIterations: { kind: "positiveInt" },
  maxTokens: { kind: "positiveInt" },
  contextTokenLimit: { kind: "positiveSafeInt" },
  modelContextWindow: { kind: "positiveSafeInt" },
  /**
   * The dollar budget and its pricing pair (WP09.3/L07). Dollars are a
   * quantity of money, not a token count, so the number is positive with
   * decimals allowed; a ceiling without both pricing keys is refused at run
   * preparation rather than silently unenforced.
   */
  maxBudgetUsd: { kind: "positiveNumber" },
  inputPricePerMTok: { kind: "positiveNumber" },
  outputPricePerMTok: { kind: "positiveNumber" },
  /**
   * Path to a JSON file naming language servers (WP12 L60).
   *
   * A *path*, not the servers themselves: the settings file only holds flat
   * key-values, and a server entry (name, command, extensions) does not fit
   * any closed kind. The file is read and validated at the turn boundary, so
   * editing it takes effect on the next run with nothing to clear — the same
   * freeze rule as roles. Absent means no `lsp_navigate` in the catalog at
   * all (the cost contract), and it is deliberately NOT in PACKAGED_DEFAULTS:
   * a packaged path would start a program for every user of the build.
   */
  lspConfigFile: { kind: "string" },
};

/**
 * In-code defaults, not a file. Every key here must satisfy {@link SETTINGS_SCHEMA};
 * `schema.test.ts` asserts that, so a drift between the defaults and the closed
 * set turns the build red instead of producing an unrenderable config.
 *
 * Context settings stay optional here. The context-window policy resolves an
 * absent preference to 200K and clamps it to declared model capacities.
 *
 * Request-count and cumulative output budgets are opt-in, like the reference
 * execution policy. Model/provider generation limits remain authoritative;
 * packaged defaults must not turn a normal coding task into a budgeted run.
 */
export const PACKAGED_DEFAULTS: SettingsValues = {
  provider: "fixture",
  format: "text",
  endpoint: "",
};

const SECRET_KEY_EXACT: ReadonlySet<string> = new Set(["apiKey", "token", "authorization"]);

/** True for any key that would hold a credential. Case-insensitive on `secret`. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_EXACT.has(key) || key.toLowerCase().includes("secret");
}

const MCP_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["mcpServers", "mcp", "servers"]);

/** True for keys owned by the MCP registry rather than by settings. */
export function isMcpForbiddenKey(key: string): boolean {
  return MCP_FORBIDDEN_KEYS.has(key);
}

/**
 * Keys whose array values merge by concatenation instead of override.
 *
 * This package's closed set has **no** array key, so the set is empty — but the
 * concat mechanism is real and tested (`merge.ts`), because D6 §10.7 names
 * "arrays merge rather than overwrite" (opencode `mergeConfigConcatArrays`) as a
 * delivery-face common denominator. The day a key is added here, the merge path
 * already does the right thing; the mechanism is parameterized by this predicate
 * rather than hardcoded, so nothing sits unreachable in the production path.
 */
export const CONCAT_ARRAY_KEYS: ReadonlySet<string> = new Set<string>();

export function isConcatKey(key: string): boolean {
  return CONCAT_ARRAY_KEYS.has(key);
}

export function isSchemaKey(key: string): boolean {
  return Object.hasOwn(SETTINGS_SCHEMA, key);
}

function failure(code: SettingsFailure["code"], detail: string): SettingsFailure {
  return { ok: false, code, detail };
}

function isPositiveInt(value: JsonValue): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositiveNumber(value: JsonValue): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Validate one value against its key's spec. Returns a failure or `undefined`. */
function validateValue(
  spec: KeySpec,
  value: JsonValue,
  key: string,
  source: string,
): SettingsFailure | undefined {
  switch (spec.kind) {
    case "enum":
      if (typeof value !== "string" || !spec.members.includes(value)) {
        return failure(
          "invalid_value",
          `${source}: ${key} must be one of ${spec.members.map((m) => JSON.stringify(m)).join(", ")}`,
        );
      }
      return undefined;
    case "string":
      if (typeof value !== "string") {
        return failure("invalid_value", `${source}: ${key} must be a string`);
      }
      return undefined;
    case "positiveInt":
      if (!isPositiveInt(value)) {
        return failure("invalid_value", `${source}: ${key} must be a positive integer`);
      }
      return undefined;
    case "positiveSafeInt":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        return failure("invalid_value", `${source}: ${key} must be a positive safe integer`);
      }
      return undefined;
    case "positiveNumber":
      if (!isPositiveNumber(value)) {
        return failure("invalid_value", `${source}: ${key} must be a positive number`);
      }
      return undefined;
  }
}

/**
 * Validate a plain object against the closed schema. Shared by the file parser
 * (after `formatVersion` is stripped) and the CLI-flag path, so both reject the
 * exact same key set. A single refusal fails the whole object — the caller
 * decides what that means for the load (it is fail-closed at the top).
 */
export function validateSettingsObject(
  obj: Readonly<Record<string, JsonValue>>,
  source: string,
): { readonly ok: true; readonly values: SettingsValues } | SettingsFailure {
  const values: Record<string, JsonValue> = {};
  for (const key of Object.keys(obj)) {
    if (isSecretKey(key)) {
      return failure(
        "secret_key",
        `${source}: key ${JSON.stringify(key)} holds a credential and is refused by the settings schema (secrets belong to the credentials package)`,
      );
    }
    if (isMcpForbiddenKey(key)) {
      return failure(
        "forbidden_key",
        `${source}: key ${JSON.stringify(key)} declares an MCP server and is refused here (the MCP registry owns it)`,
      );
    }
    const spec = SETTINGS_SCHEMA[key];
    if (spec === undefined) {
      return failure("unknown_key", `${source}: unknown key ${JSON.stringify(key)}`);
    }
    const value = obj[key];
    if (value === undefined) {
      // Cannot happen for a JSON-derived object, but the index signature says so.
      continue;
    }
    const valueFailure = validateValue(spec, value, key, source);
    if (valueFailure !== undefined) {
      return valueFailure;
    }
    values[key] = value;
  }
  return { ok: true, values };
}
