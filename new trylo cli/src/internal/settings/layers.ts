/**
 * The five configuration layers and their precedence.
 *
 * This enumeration is owned by the settings package and is deliberately *not*
 * shared with `config/layers.ts` (the older four-layer loader). Coupling the two
 * would freeze the old loader's merge behaviour into this one, so the five-layer
 * model is free to name `system` explicitly while the old one has no slot for it.
 *
 * `config/layers.ts` is **no longer reachable from the CLI**: `surface/cli/config-load.ts`
 * drives this package through `adapters/settings-fs.ts`, and a boundary test pins
 * that no file under `surface/cli/**` imports the old loader. The old module is
 * kept only for non-CLI callers that have not migrated yet; it is not a second
 * load path for any command a user can run.
 *
 * Precedence, lowest to highest:
 *
 * ```text
 * packaged_default(0) -> system(10) -> user(20) -> project(30) -> cli_flag(40)
 * ```
 *
 * Environment variables are *not* a layer here, matching `config/layers.ts`:
 * they carry secrets and explicit overrides only, and secrets belong to the
 * credentials package, never to a settings file this loader will read.
 *
 * The numeric shape is copied from codex `ConfigLayerSource.precedence()`
 * (D6 §4.1): a sparse integer scale so a future layer can be inserted between
 * two existing ones without renumbering.
 */

/** Ordered lowest precedence first. The array order *is* the merge order. */
export const SETTINGS_LAYERS = [
  "packaged_default",
  "system",
  "user",
  "project",
  "cli_flag",
] as const;

export type SettingsLayer = (typeof SETTINGS_LAYERS)[number];

const PRECEDENCE: Readonly<Record<SettingsLayer, number>> = {
  packaged_default: 0,
  system: 10,
  user: 20,
  project: 30,
  cli_flag: 40,
};

export function layerPrecedence(layer: SettingsLayer): number {
  return PRECEDENCE[layer];
}

export function isSettingsLayer(value: string): value is SettingsLayer {
  return (SETTINGS_LAYERS as readonly string[]).includes(value);
}

/**
 * Layers backed by a file on disk. `packaged_default` is an in-code constant and
 * `cli_flag` is an already-parsed object handed in by the caller, so neither is
 * discovered or read here.
 */
export const FILE_BACKED_LAYERS = ["system", "user", "project"] as const;

export type FileBackedLayer = (typeof FILE_BACKED_LAYERS)[number];
