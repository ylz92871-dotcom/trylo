import type { AcquisitionFailure } from "./guarded-get.js";
import { fetchJson } from "./fetch-json.js";
import type { HttpTransport } from "./transport.js";
import { recordOf } from "../../domain/evolution/parse.js";
import { npmDependencySpecs } from "./npm-dependency-specs.js";
import { checkNpmArchiveIdentity, exactNpmVersion } from "./npm-tree-resolution.js";
import { NpmTreeError } from "./npm-tree-contract.js";
import { unsupportedNpmArchiveCode, type NpmUnsupportedArchive } from "./npm-registry-unsupported.js";

export const NPM_INSTALL_METADATA_ACCEPT = "application/vnd.npm.install-v1+json";

export type NpmRegistryDiagnostic = { readonly packageName: string; readonly version?: string;
  readonly stage: "metadata_fetch" | "metadata_projection" | "selected_archive_semantics"; readonly code: AcquisitionFailure
    | "invalid_npm_metadata" | "unsupported_npm_dependency" | "unsupported_npm_source"
    | "npm_shrinkwrap_unsupported" | "npm_bundled_dependency_unsupported" };

export type NpmRegistryDiagnostics = ReturnType<typeof npmRegistryDiagnostics>;

/** Diagnostics are host facts, never arbitrary npm stderr or publisher prose. */
export function npmRegistryDiagnostics(selected?: { readonly name: string; readonly version: string }) {
  const rows: NpmRegistryDiagnostic[] = [];
  const priority = (row: NpmRegistryDiagnostic) => row.stage === "selected_archive_semantics" ? 4 : row.stage === "metadata_fetch" ? 3
    : row.packageName === selected?.name && (row.version === undefined || row.version === selected.version) ? 2 : 1;

  return { add(row: NpmRegistryDiagnostic) {
    const key = JSON.stringify(row);
    if (rows.some(existing => JSON.stringify(existing) === key)) return;

    if (rows.length < 16) rows.push(row);
    else {
      const least = rows.findIndex(existing => priority(existing) < priority(row));
      if (least >= 0) rows.splice(least, 1, row);
    }
  }, read: (): readonly NpmRegistryDiagnostic[] => rows.map(row => ({ ...row })).sort((a, b) => priority(b) - priority(a)) };
}

/** Header-only adaptation: every URL, redirect, byte cap and deadline still passes guardedGet. */
export function fetchNpmRegistryMetadata(transport: HttpTransport, name: string, signal: AbortSignal) {
  const metadataTransport: HttpTransport = { get: request => transport.get({ ...request,
    headers: { ...request.headers, accept: NPM_INSTALL_METADATA_ACCEPT } }) };
  return fetchJson(metadataTransport, `https://registry.npmjs.org/${encodeURIComponent(name)}`, signal);
}

/** Preserve supported solver semantics, refusing unsupported archives only after npm selects them. */
export function npmRegistryMetadata(name: string, raw: unknown, diagnostics: NpmRegistryDiagnostics,
  blockArchive: (binding: NpmUnsupportedArchive) => string) {
  if (!recordOf(raw) || !recordOf(raw.versions)) {
    diagnostics.add({ packageName: name, stage: "metadata_projection", code: "invalid_npm_metadata" });
    return undefined;
  }

  const versions: Record<string, unknown> = {};

  for (const [version, value] of Object.entries(raw.versions)) {
    if (!exactNpmVersion(version) || !recordOf(value) || value.name !== name || value.version !== version || !recordOf(value.dist)) continue;

    const reject = (code: NpmRegistryDiagnostic["code"]) => diagnostics.add({ packageName: name, version, stage: "metadata_projection", code });

    try {
      npmDependencySpecs(value);
      const archiveUrl = checkNpmArchiveIdentity(value.dist.tarball, name, version);

      if (typeof value.dist.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.dist.integrity)
        || Buffer.from(value.dist.integrity.slice(7), "base64").toString("base64") !== value.dist.integrity.slice(7)) {
        reject("invalid_npm_metadata");
        continue;
      }

      const code = unsupportedNpmArchiveCode(value);
      const tarball = code === undefined ? archiveUrl : blockArchive({ packageName: name, version, archiveUrl, integrity: value.dist.integrity, code });
      const entry: Record<string, unknown> = { name, version, dist: { tarball, integrity: value.dist.integrity } };

      for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "engines", "os", "cpu", "libc", "bin", "license", "deprecated",
        "_hasShrinkwrap", "hasShrinkwrap", "bundleDependencies", "bundledDependencies"]) {
        if (value[key] !== undefined) entry[key] = value[key];
      }

      // install-v1 omits scripts, but publishes this fact explicitly.
      const scripts = value.scripts;
      if (value.hasInstallScript === true || recordOf(scripts) && ["preinstall", "install", "postinstall"].some(key => Object.hasOwn(scripts, key))) entry.hasInstallScript = true;

      versions[version] = entry;
    } catch (error) {
      reject(error instanceof NpmTreeError && error.code === "unsupported_npm_source" ? "unsupported_npm_source" : "unsupported_npm_dependency");
    }
  }

  const rawTags = raw["dist-tags"];
  const tags = recordOf(rawTags) ? Object.fromEntries(Object.entries(rawTags)
    .filter(([, version]) => typeof version === "string" && Object.hasOwn(versions, version))) : {};

  if (Object.keys(versions).length === 0 && diagnostics.read().every(row => row.packageName !== name)) {
    diagnostics.add({ packageName: name, stage: "metadata_projection", code: "invalid_npm_metadata" });
  }

  return { name, versions, "dist-tags": tags };
}
