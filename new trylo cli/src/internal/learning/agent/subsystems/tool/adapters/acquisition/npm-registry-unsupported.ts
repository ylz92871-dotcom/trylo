import { createHash } from "node:crypto";
import { recordOf } from "../../domain/evolution/parse.js";
import { packageNameAt } from "./npm-tree-resolution.js";

export type NpmUnsupportedArchiveCode = "npm_shrinkwrap_unsupported" | "npm_bundled_dependency_unsupported";

export type NpmUnsupportedArchive = { readonly packageName: string; readonly version: string; readonly archiveUrl: string;
  readonly integrity: string; readonly code: NpmUnsupportedArchiveCode };

const ROUTE = "/_trylo_unsupported_archive/";

/** Local refusal coordinates are not registry archives or reviewed source identities. */
export function npmUnsupportedArchives() {
  const byUrl = new Map<string, NpmUnsupportedArchive>(), byRoute = new Map<string, NpmUnsupportedArchive>();
  return {
    block(baseUrl: string, binding: NpmUnsupportedArchive): string {
      const route = `${ROUTE}${createHash("sha256").update(JSON.stringify(binding)).digest("hex")}`;
      const url = new URL(route, baseUrl).toString();
      byUrl.set(url, binding);
      byRoute.set(route, binding);
      return url;
    },
    requested(route: string): NpmUnsupportedArchive | undefined { return byRoute.get(route); },
    fromLock(lock: unknown): { readonly code: NpmUnsupportedArchiveCode; readonly binding: NpmUnsupportedArchive }
      | { readonly code: "invalid_npm_lock" } | undefined {
      if (!recordOf(lock) || !recordOf(lock.packages)) return undefined;

      for (const [location, value] of Object.entries(lock.packages)) {
        if (!recordOf(value) || typeof value.resolved !== "string") continue;

        const binding = byUrl.get(value.resolved);
        if (binding === undefined) continue;

        let name: string;

        try { name = value.name === undefined ? packageNameAt(location) : String(value.name); }
        catch { return { code: "invalid_npm_lock" }; }

        if (name !== binding.packageName || value.version !== binding.version) return { code: "invalid_npm_lock" };

        return { code: binding.code, binding };
      }

      return undefined;
    },
  };
}

export function unsupportedNpmArchiveCode(value: Record<string, unknown>): NpmUnsupportedArchiveCode | undefined {
  if (value._hasShrinkwrap === true || value.hasShrinkwrap === true) return "npm_shrinkwrap_unsupported";
  if ([value.bundleDependencies, value.bundledDependencies].some(raw => raw !== undefined
    && (!Array.isArray(raw) || raw.length !== 0))) return "npm_bundled_dependency_unsupported";
  return undefined;
}
