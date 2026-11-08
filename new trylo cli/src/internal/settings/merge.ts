import type { JsonValue } from "../protocol/envelope.js";
import type { ResolvedSettings, SettingsEntry, SettingsValues } from "../ports/settings.js";
import { layerPrecedence, type SettingsLayer } from "./layers.js";
import { isConcatKey } from "./schema.js";

/**
 * Merge validated layer contributions into one resolved config.
 *
 * Rules, stated once:
 *
 *  - **Higher precedence wins** on a scalar. Layers are applied lowest
 *    precedence first, so a later layer simply replaces the entry.
 *  - **Concat keys merge instead of overwrite.** No key in this package's closed
 *    set is a concat key today, so production merging is pure override; the
 *    concat policy is injected as a predicate (`isConcat`) rather than hardcoded,
 *    which keeps the mechanism real and unit-tested without leaving an unreachable
 *    branch in the load path. Copied from opencode `mergeConfigConcatArrays`
 *    (D6 §10.7): when a future key is declared concat, its arrays append and
 *    de-duplicate instead of the high layer clobbering the low one.
 *  - **Fail-closed happens before this function.** An invalid layer never reaches
 *    the merge; the loader refuses the whole load first. A *missing* layer
 *    contributes an empty value set, which is why it simply adds nothing here.
 */

export type LayerContribution = {
  readonly layer: SettingsLayer;
  readonly values: SettingsValues;
};

/**
 * Append two string arrays and de-duplicate, preserving first-seen order. Pure.
 * Non-string members are not this function's problem: callers only reach it via
 * {@link mergeValue}, which gates on both sides being string arrays.
 */
export function concatStringArrays(
  base: ReadonlyArray<string>,
  override: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of [...base, ...override]) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }

  return out;
}

function isStringArray(value: JsonValue): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Combine a low-precedence value with a high-precedence one for a single key.
 * Concat keys with two string arrays append; everything else (and any concat key
 * whose values are not both string arrays) takes the override.
 */
export function mergeValue(
  key: string,
  base: JsonValue,
  override: JsonValue,
  isConcat: (key: string) => boolean = isConcatKey,
): JsonValue {
  if (isConcat(key) && isStringArray(base) && isStringArray(override)) {
    return concatStringArrays(base, override);
  }
  return override;
}

export function resolveSettings(contributions: ReadonlyArray<LayerContribution>): ResolvedSettings {
  const ordered = [...contributions].sort(
    (a, b) => layerPrecedence(a.layer) - layerPrecedence(b.layer),
  );
  const resolved: Record<string, SettingsEntry> = {};

  for (const { layer, values } of ordered) {
    for (const key of Object.keys(values)) {
      const value = values[key];
      if (value === undefined) {
        continue;
      }

      const existing = resolved[key];

      resolved[key] =
        existing === undefined
          ? { value, layer }
          : { value: mergeValue(key, existing.value, value), layer };
    }
  }

  return resolved;
}
