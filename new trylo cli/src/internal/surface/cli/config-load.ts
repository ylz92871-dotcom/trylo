import type { JsonValue } from "../../protocol/envelope.js";
import {
  loadSettingsDetailed,
  type SettingsDetailedFailure,
  type SettingsSourceRecord,
  type SettingsSourceStatus,
} from "../../adapters/settings-fs.js";
import type {
  ResolvedSettings,
  SettingsValues,
} from "../../ports/settings.js";
import type { SettingsLayer } from "../../settings/layers.js";
import { publicSettingsView } from "../../settings/view.js";

/**
 * Config loading — the CLI's *only* load path.
 *
 * The engine is the five-layer settings package (`settings/**` driven by
 * `adapters/settings-fs.ts`): `discover` finds each layer's candidates, `parse`
 * validates them against the closed schema, `merge` applies `layerPrecedence`,
 * and `view` produces the public rendering. This file is a thin, CLI-shaped
 * adapter over that one call — it holds no second merge, no second default set
 * and no fallback to the older four-layer loader.
 *
 * Precedence, lowest to highest (sparse integer scale, copied from codex
 * `ConfigLayerSource::precedence`, D6 §4.1):
 *
 * ```text
 * packaged_default(0) -> system(10) -> user(20) -> project(30) -> cli_flag(40)
 * ```
 *
 * Environment variables are *not* a layer, and neither are credentials: a
 * credential resolves through `CredentialPort` (see `credentials-wiring.ts`),
 * which owns the declared environment table and the ledger files. A config file
 * may not even *carry* an `apiKey`: the closed schema refuses secret keys by
 * name, so the value never enters the resolved map to be redacted later.
 *
 * `cli_flag` is built from already-parsed argv (`run-settings.ts::flagLayer`),
 * never from the environment.
 */

export type LayerSource = SettingsSourceRecord;

export type LayerSourceStatus = SettingsSourceStatus;

export type ConfigLoadIo = {
  /** Returns the file's text, or `undefined` when it does not exist. */
  readonly readFile: (absolutePath: string) => string | undefined;
  /**
   * The **profile root** the user layer reads `config.json` from.
   *
   * Resolved by the caller through `tryloHome`, so `TRYLO_HOME` moves the config
   * file together with the credentials and the sessions instead of leaving the
   * config behind in the default profile.
   */
  readonly profileDir: string;
  /** Workspace root; the project layer reads `<workspace>/.trylo/config.json`. */
  readonly cwd: string;
  /**
   * Directory holding a managed/system `config.json`. Absent means there is no
   * system layer on this machine — *missing*, not an error. The CLI does not
   * currently resolve one (which platform convention owns it is a separate
   * decision); it is an explicit injection point so the five-layer order is
   * exercised end to end rather than only in the settings package.
   */
  readonly systemDir?: string | undefined;
};

export type ConfigFailure = SettingsDetailedFailure;

export type LoadedConfig =
  | {
      readonly ok: true;
      readonly resolved: ResolvedSettings;
      readonly sources: ReadonlyArray<LayerSource>;
    }
  | { readonly ok: false; readonly failure: ConfigFailure };

export function loadConfig(io: ConfigLoadIo, flagValues: SettingsValues): LoadedConfig {
  const detailed = loadSettingsDetailed(
    { readFile: io.readFile },
    {
      // The user layer's home *is* the profile root: one formula, one profile.
      homeDir: io.profileDir,
      workspaceDir: io.cwd,
      ...(io.systemDir === undefined ? {} : { systemDir: io.systemDir }),
      cliFlag: flagValues,
    },
  );
  if (!detailed.ok) {
    return { ok: false, failure: detailed };
  }

  return { ok: true, resolved: detailed.value, sources: detailed.sources };
}

/**
 * The renderable values. Every entry carries the layer that supplied it, so
 * `config show` answers "why is this value what it is" without diffing files.
 * Secret keys are structurally absent: the schema refused them at parse time,
 * and `settings/view.ts` drops them again on the way out.
 */
export type ConfigValueEntry = {
  readonly value: JsonValue;
  readonly sourceLayer: SettingsLayer;
};

export function configValueView(resolved: ResolvedSettings): Readonly<Record<string, ConfigValueEntry>> {
  const view = publicSettingsView(resolved);
  const out: Record<string, ConfigValueEntry> = {};

  for (const key of Object.keys(view)) {
    const entry = view[key];
    if (entry === undefined) {
      continue;
    }
    out[key] = { value: entry.value, sourceLayer: entry.layer };
  }

  return out;
}
