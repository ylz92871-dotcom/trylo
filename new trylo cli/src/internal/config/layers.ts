import type { JsonValue } from "../protocol/envelope.js";

/**
 * Configuration layering contract.
 *
 * Precedence, lowest to highest: packaged default -> user JSON -> project JSON
 * -> CLI flags. Environment variables are *not* a general layer: they carry
 * secrets and explicit overrides only, and secret values never leave this
 * module's redaction boundary into `config show`, `doctor`, error text, the
 * session journal or stream-json.
 */

export const CONFIG_LAYERS = ["packaged_default", "user", "project", "cli_flag"] as const;

export type ConfigLayer = (typeof CONFIG_LAYERS)[number];

const PRECEDENCE: Readonly<Record<ConfigLayer, number>> = {
  packaged_default: 0,
  user: 10,
  project: 20,
  cli_flag: 30,
};

export function layerPrecedence(layer: ConfigLayer): number {
  return PRECEDENCE[layer];
}

export function isConfigLayer(value: string): value is ConfigLayer {
  return (CONFIG_LAYERS as readonly string[]).includes(value);
}

export type ConfigEntry = {
  readonly value: JsonValue;
  readonly layer: ConfigLayer;
  readonly secret: boolean;
};

export type ResolvedConfig = Readonly<Record<string, ConfigEntry>>;

export type LayerValues = Readonly<Record<string, JsonValue>>;

/**
 * Keys whose values must never be rendered. A key present here is treated as
 * secret in every layer, including packaged defaults.
 */
export const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "apiKey",
  "apiKeyEnv",
  "authorization",
  "token",
]);

const REDACTED = "<redacted>";

function entryFor(value: JsonValue, layer: ConfigLayer, secret: boolean): ConfigEntry {
  return { value, layer, secret };
}

function isSecretKey(key: string): boolean {
  return SECRET_CONFIG_KEYS.has(key) || key.toLowerCase().includes("secret");
}

/**
 * Merge layers into one resolved config. Higher-precedence layers win; equal
 * precedence keeps the earlier value so the merge is deterministic and
 * independent of object key order.
 */
export function mergeConfigLayers(
  layers: ReadonlyArray<{ readonly layer: ConfigLayer; readonly values: LayerValues }>,
): ResolvedConfig {
  const resolved: Record<string, ConfigEntry> = {};
  const ordered = [...layers].sort((a, b) => layerPrecedence(a.layer) - layerPrecedence(b.layer));

  for (const { layer, values } of ordered) {
    for (const key of Object.keys(values)) {
      const value = values[key];
      if (value === undefined) {
        continue;
      }

      const existing = resolved[key];
      const secret = isSecretKey(key);

      if (existing === undefined) {
        resolved[key] = entryFor(value, layer, secret);
        continue;
      }

      if (layerPrecedence(layer) > layerPrecedence(existing.layer)) {
        resolved[key] = entryFor(value, layer, secret);
      }
    }
  }

  return resolved;
}

/**
 * Render a config for humans or JSON consumers. Secret entries collapse to a
 * constant placeholder; the *source layer* of a secret is still reported so a
 * user can see where it came from without seeing the value.
 */
export function publicConfigView(config: ResolvedConfig): Record<string, JsonValue> {
  const view: Record<string, JsonValue> = {};

  for (const key of Object.keys(config).sort()) {
    const entry = config[key];
    if (entry === undefined) {
      continue;
    }
    view[key] = entry.secret ? REDACTED : entry.value;
  }

  return view;
}

export function configSourceView(config: ResolvedConfig): Record<string, string> {
  const view: Record<string, string> = {};

  for (const key of Object.keys(config).sort()) {
    const entry = config[key];
    if (entry === undefined) {
      continue;
    }
    view[key] = entry.layer;
  }

  return view;
}

export function readString(config: ResolvedConfig, key: string): string | undefined {
  const entry = config[key];
  return typeof entry?.value === "string" ? entry.value : undefined;
}

export function readNumber(config: ResolvedConfig, key: string): number | undefined {
  const entry = config[key];
  return typeof entry?.value === "number" ? entry.value : undefined;
}
