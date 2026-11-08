import { err, ok, type Result } from "../contract/result.js";

/**
 * WP16.1 plugin bundle manifest (thin bridge over legacy + Codex shapes).
 *
 * Reused mechanics (provenance, not copied runtime):
 * - legacy `utils/plugins/pluginLoader.loadPluginManifest` — manifest must
 *   carry id/version and list contributed skills/MCP/agents/styles; a bundle
 *   is never a loose tool registry.
 * - legacy `services/plugins/pluginOperations` scope model —
 *   `user/project/local` installable, `managed` update-only.
 * - Codex `plugin/manifest + provider` — marketplace bundles are versioned and
 *   installable; `cli plugin marketplace add/list/upgrade/remove` is the CLI
 *   surface (see actual-revalidation table).
 *
 * This module is pure validation: no filesystem, no network, no installer.
 * The registry (`registry.ts`) owns lifecycle; this module owns shape.
 */

export type PluginInstallScope = "user" | "project" | "local" | "managed";

export const INSTALLABLE_SCOPES: readonly PluginInstallScope[] = ["user", "project", "local"];

export type PluginOrigin = "marketplace" | "local-dir" | "inline-dir" | "builtin";

export type PluginManifest = {
  readonly pluginId: string;
  readonly version: string;
  readonly marketplace?: string;
  readonly skills: readonly string[];
  readonly mcpServers: readonly string[];
  readonly agents: readonly string[];
  readonly commands: readonly string[];
  readonly outputStyles: readonly string[];
};

export type PluginManifestFailure =
  | "empty_plugin_id"
  | "invalid_plugin_id"
  | "empty_version"
  | "path_traversal"
  | "empty_bundle"
  | "duplicate_contribution";

function hasTraversal(value: string): boolean {
  return value.includes("..") || value.includes("\0");
}

function isValidIdChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95 ||
    code === 46 ||
    code === 58 ||
    code === 47 ||
    code === 64
  );
}

/** `name[@marketplace]` — mirrors legacy `parsePluginIdentifier` shape. */
export function parsePluginId(raw: string): Result<{ name: string; marketplace?: string }, PluginManifestFailure> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return err("empty_plugin_id", "plugin id is empty");
  }

  if (hasTraversal(trimmed)) {
    return err("path_traversal", `plugin id refuses traversal: ${trimmed}`);
  }

  for (const code of [...trimmed].map((ch) => ch.codePointAt(0) ?? 0)) {
    if (!isValidIdChar(code)) {
      return err("invalid_plugin_id", `plugin id carries an illegal character: ${trimmed}`);
    }
  }

  const at = trimmed.lastIndexOf("@");
  if (at <= 0) {
    return ok({ name: trimmed });
  }

  const name = trimmed.slice(0, at);
  const marketplace = trimmed.slice(at + 1);
  if (name.length === 0 || marketplace.length === 0) {
    return err("invalid_plugin_id", `plugin id is not name[@marketplace]: ${trimmed}`);
  }

  return ok({ name, marketplace });
}

/** Legacy builtin marker: `<name>@builtin`. */
export function isBuiltinPluginId(pluginId: string): boolean {
  return pluginId.endsWith("@builtin");
}

export function validatePluginManifest(input: {
  readonly pluginId: string;
  readonly version: string;
  readonly marketplace?: string;
  readonly skills?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly agents?: readonly string[];
  readonly commands?: readonly string[];
  readonly outputStyles?: readonly string[];
}): Result<PluginManifest, PluginManifestFailure> {
  const id = parsePluginId(input.pluginId);
  if (!id.ok) {
    return id;
  }

  if (input.version.trim().length === 0) {
    return err("empty_version", "plugin version is empty");
  }

  if (hasTraversal(input.version)) {
    return err("path_traversal", "plugin version refuses traversal");
  }

  if (input.marketplace !== undefined && hasTraversal(input.marketplace)) {
    return err("path_traversal", `plugin marketplace refuses traversal: ${input.marketplace}`);
  }

  const lists = {
    skills: input.skills ?? [],
    mcpServers: input.mcpServers ?? [],
    agents: input.agents ?? [],
    commands: input.commands ?? [],
    outputStyles: input.outputStyles ?? [],
  };

  for (const entries of Object.values(lists)) {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.length === 0 || hasTraversal(entry)) {
        return err("path_traversal", `plugin contribution refuses empty/traversal entry: ${entry}`);
      }

      if (seen.has(entry)) {
        return err("duplicate_contribution", `plugin contribution is declared twice: ${entry}`);
      }

      seen.add(entry);
    }
  }

  const total =
    lists.skills.length +
    lists.mcpServers.length +
    lists.agents.length +
    lists.commands.length +
    lists.outputStyles.length;
  if (total === 0) {
    return err("empty_bundle", `plugin ${input.pluginId} contributes nothing; bundles are not loose registries`);
  }

  return ok({
    pluginId: input.pluginId,
    version: input.version,
    ...(input.marketplace === undefined ? {} : { marketplace: input.marketplace }),
    ...lists,
  });
}

export function isInstallableScope(scope: PluginInstallScope): boolean {
  return INSTALLABLE_SCOPES.includes(scope);
}
