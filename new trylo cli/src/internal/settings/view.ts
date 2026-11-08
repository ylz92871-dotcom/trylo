import type { ResolvedSettings, SettingsEntry, SettingsPublicView } from "../ports/settings.js";
import { isMcpForbiddenKey, isSecretKey } from "./schema.js";

/**
 * The sanitized public view.
 *
 * Two layers of defence make "a secret never renders" a structural fact rather
 * than a hope:
 *
 *  1. The schema refuses secret and MCP keys at parse time, so they cannot be in
 *     `resolved` to begin with.
 *  2. This function drops them *again* before returning. Defence in depth: even
 *     if a future refactor let a forbidden key into the resolved map, the render
 *     path would still not emit it. `endpoint` survives — it is a URL, not a
 *     credential, and a user legitimately needs to see which endpoint is active.
 *
 * Every surviving key carries the layer that supplied it, so `config show` can
 * answer "why is this value what it is" without diffing files. Keys are sorted for
 * a stable, diffable rendering.
 */
export function publicSettingsView(resolved: ResolvedSettings): SettingsPublicView {
  const view: Record<string, SettingsEntry> = {};

  for (const key of Object.keys(resolved).sort()) {
    if (isSecretKey(key) || isMcpForbiddenKey(key)) {
      continue;
    }

    const entry = resolved[key];
    if (entry === undefined) {
      continue;
    }

    view[key] = { value: entry.value, layer: entry.layer };
  }

  return view;
}
