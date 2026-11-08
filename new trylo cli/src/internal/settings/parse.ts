import type { JsonValue } from "../protocol/envelope.js";
import type { SettingsFailure, SettingsValues } from "../ports/settings.js";
import { SETTINGS_FORMAT_VERSION, validateSettingsObject } from "./schema.js";

/**
 * Parse one layer's file content into validated settings values.
 *
 * Pure: no I/O, so every hostile document is a unit test rather than a fixture
 * on disk someone has to keep in sync. The caller decides whether a file was
 * missing (it hands us `status: "missing"`) or present (it hands us the bytes).
 *
 * Three outcomes are kept distinct on purpose:
 *
 *  - **missing** — the file does not exist. This contributes nothing and is *not*
 *    an error; a machine with no user config still loads (everything falls
 *    through to packaged defaults).
 *  - **invalid** — the file exists but cannot be honoured: bad JSON, a non-object
 *    document, an unknown/secret/MCP key, a wrong `formatVersion`, or a value
 *    that fails its rule. Invalid is fail-closed at the top of the loader; it is
 *    never silently downgraded to "missing", because reporting a broken file as
 *    "not configured" is how a user's real intent gets discarded.
 *  - **present** — a well-formed object, possibly empty (`{}`), yielding values.
 */

export type LayerContent =
  | { readonly status: "missing" }
  | { readonly status: "present"; readonly raw: string };

export type ParsedLayer =
  | { readonly ok: true; readonly values: SettingsValues }
  | SettingsFailure;

function failure(code: SettingsFailure["code"], detail: string): SettingsFailure {
  return { ok: false, code, detail };
}

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the `formatVersion` meta key. Absent means version 1 (the only one
 * this build reads); present and different is a hard failure, because a document
 * written by a newer format may mean something this loader cannot express and
 * reading it optimistically would silently drop fields.
 */
function checkFormatVersion(
  value: JsonValue | undefined,
  source: string,
): SettingsFailure | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value !== SETTINGS_FORMAT_VERSION) {
    return failure(
      "unknown_format_version",
      `${source}: formatVersion ${JSON.stringify(value)} is not supported (this build reads ${SETTINGS_FORMAT_VERSION})`,
    );
  }

  return undefined;
}

export function parseLayerContent(content: LayerContent, source: string): ParsedLayer {
  if (content.status === "missing") {
    return { ok: true, values: {} };
  }

  const raw = content.raw;
  if (raw.trim().length === 0) {
    // Zero bytes / whitespace is a file somebody created and never finished, not
    // an empty config. `{}` is the empty config; "" is a broken file.
    return failure("invalid_json", `${source}: file is empty`);
  }

  let parsed: JsonValue;

  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    return failure("invalid_json", `${source}: not valid JSON`);
  }

  if (!isJsonObject(parsed)) {
    return failure("invalid_json", `${source}: document is not a JSON object`);
  }

  const versionFailure = checkFormatVersion(parsed["formatVersion"], source);
  if (versionFailure !== undefined) {
    return versionFailure;
  }

  // Strip the meta key, then validate the rest against the closed schema.
  const rest: Record<string, JsonValue> = {};

  for (const key of Object.keys(parsed)) {
    if (key === "formatVersion") {
      continue;
    }

    const value = parsed[key];
    if (value !== undefined) {
      rest[key] = value;
    }
  }

  return validateSettingsObject(rest, source);
}

/**
 * Validate an already-parsed CLI-flag object. There is no `formatVersion` here —
 * flags are not a versioned document — so any key outside the closed set,
 * including a literal `formatVersion`, is refused by the shared schema check.
 */
export function validateCliFlag(values: SettingsValues): ParsedLayer {
  return validateSettingsObject(values, "cli_flag");
}
