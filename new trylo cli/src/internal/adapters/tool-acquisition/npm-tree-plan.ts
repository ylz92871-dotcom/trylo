import { contentHashOf } from "../../learning/control/hash.js";
import { isJsonValue, jsonBytes, recordOf, textOf } from "../../learning/domains/tool/evolution/parse.js";
import { MAX_NPM_LOCK_ENTRIES, MAX_NPM_TREE_PACKAGES, NpmTreeError, type NpmDependencyEdge, type NpmInstallTarget, type NpmLockedPackage, type NpmLockedTree } from "./npm-tree-contract.js";
import { checkNpmArchiveIdentity, checkNpmNodeEngine, dependencyLocations, exactNpmVersion, npmPlatformCompatible, npmVersionSatisfies, packageNameAt, validNpmName } from "./npm-tree-resolution.js";
import { npmDependencySpecs } from "./npm-dependency-specs.js";

type LockedEntry = { readonly location: string; readonly name: string; readonly version: string; readonly archiveUrl: string; readonly integrity: string; readonly metadata: Record<string, unknown> };

/** Freeze only the reachable runtime tree. A lock is untrusted input, not a verified manifest or grant. */
export function planNpmLockedTree(input: { readonly scope: string; readonly name: string; readonly version: string; readonly target: NpmInstallTarget; readonly lock: unknown }) {
  try { return { ok: true as const, tree: freeze(input) }; }
  catch (error) { return { ok: false as const, code: error instanceof NpmTreeError ? error.code : "invalid_npm_lock", message: "npm lock did not establish a bounded exact registry dependency closure" }; }
}

function freeze(input: Parameters<typeof planNpmLockedTree>[0]): NpmLockedTree {
  const lock = input.lock;
  if (!textOf(input.scope, 160) || !validNpmName(input.name) || !exactNpmVersion(input.version) || !validTarget(input.target)
    || !isJsonValue(lock, 32) || jsonBytes(lock) > 2 * 1024 * 1024 || !recordOf(lock) || lock.lockfileVersion !== 3 || !recordOf(lock.packages)
    || Object.keys(lock.packages).length > MAX_NPM_LOCK_ENTRIES) throw new NpmTreeError("invalid_npm_lock");
  const entries = new Map<string, LockedEntry>(), folded = new Set<string>();
  for (const [location, raw] of Object.entries(lock.packages)) {
    if (location === "") continue;
    const entry = readEntry(location, raw);
    if (folded.has(location.toLowerCase())) throw new NpmTreeError("invalid_npm_location");
    folded.add(location.toLowerCase()); entries.set(location, entry);
  }
  const root = entries.get(`node_modules/${input.name}`);
  if (root === undefined || root.name !== input.name || root.version !== input.version) throw new NpmTreeError("npm_dependency_mismatch");
  const project = lock.packages[""];
  if (!recordOf(project) || !recordOf(project.dependencies) || project.dependencies[input.name] !== input.version
    || Object.keys(project.dependencies).length !== 1) throw new NpmTreeError("invalid_npm_lock");
  const selected = new Map<string, NpmLockedPackage>(), queue = [root];
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (selected.has(entry.location)) continue;
    if (selected.size >= MAX_NPM_TREE_PACKAGES) throw new NpmTreeError("npm_tree_limit");
    if (!npmPlatformCompatible(entry.metadata, input.target)) throw new NpmTreeError("npm_platform_mismatch");
    if (entry.metadata.hasInstallScript === true) throw new NpmTreeError("npm_install_hook_forbidden");
    checkNpmNodeEngine(entry.metadata, input.target);
    const edges = resolveEdges(entry, entries, input.target);
    selected.set(entry.location, { location: entry.location, name: entry.name, version: entry.version, archiveUrl: entry.archiveUrl, integrity: entry.integrity, edges });
    for (const edge of edges) if (edge.resolution.kind === "package") queue.push(entries.get(edge.resolution.location)!);
  }
  checkRuntimeVisibility(selected);
  const omittedDev: string[] = [], omittedOptional: string[] = [];
  for (const entry of entries.values()) {
    if (selected.has(entry.location)) continue;
    if (entry.metadata.dev === true) omittedDev.push(entry.location);
    else if (entry.metadata.optional === true) omittedOptional.push(entry.location);
    else throw new NpmTreeError("npm_unreachable_package");
  }
  return { type: "npm_locked_tree", schemaVersion: 1, scope: input.scope, target: structuredClone(input.target),
    root: { name: input.name, version: input.version, location: root.location }, lockHash: contentHashOf(lock),
    packages: [...selected.values()].sort((a, b) => compareText(a.location, b.location)), omittedDev: omittedDev.sort(), omittedOptional: omittedOptional.sort() };
}

/** Node resolves the installed physical tree, not our peer labels or omission explanations. */
function checkRuntimeVisibility(selected: ReadonlyMap<string, NpmLockedPackage>): void {
  for (const pkg of selected.values()) for (const edge of pkg.edges) {
    const visible = dependencyLocations(pkg.location, edge.name, false).find(location => selected.has(location));
    if (edge.resolution.kind === "package" ? visible !== edge.resolution.location : visible !== undefined) throw new NpmTreeError("npm_dependency_mismatch");
  }
}

function readEntry(location: string, raw: unknown): LockedEntry {
  const installedName = packageNameAt(location);
  if (!recordOf(raw) || raw.link === true || raw.inBundle === true || !exactNpmVersion(raw.version)
    || typeof raw.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(raw.integrity)
    || Buffer.from(raw.integrity.slice(7), "base64").toString("base64") !== raw.integrity.slice(7)) throw new NpmTreeError("invalid_npm_lock");
  const name = raw.name ?? installedName;
  if (!validNpmName(name)) throw new NpmTreeError("invalid_npm_lock");
  return { location, name, version: raw.version, integrity: raw.integrity, archiveUrl: checkNpmArchiveIdentity(raw.resolved, name, raw.version), metadata: raw };
}

function resolveEdges(entry: LockedEntry, entries: ReadonlyMap<string, LockedEntry>, target: NpmInstallTarget): readonly NpmDependencyEdge[] {
  return npmDependencySpecs(entry.metadata).map(spec => {
    const { packageName, range } = spec, optional = spec.kind === "optional" || spec.kind === "optional_peer";
    const location = dependencyLocations(entry.location, spec.name, spec.kind === "peer" || spec.kind === "optional_peer").find(candidate => entries.has(candidate));
    const dependency = location === undefined ? undefined : entries.get(location);
    if (dependency === undefined && !optional) throw new NpmTreeError("missing_npm_dependency");
    if (dependency !== undefined && (dependency.name !== packageName || !npmVersionSatisfies(dependency.version, range))) throw new NpmTreeError("npm_dependency_mismatch");
    const incompatible = dependency !== undefined && !npmPlatformCompatible(dependency.metadata, target);
    if (incompatible && !optional) throw new NpmTreeError("npm_platform_mismatch");
    const resolution: NpmDependencyEdge["resolution"] = dependency === undefined || incompatible ? { kind: "omitted", reason: incompatible ? "platform_incompatible" : "not_locked" }
      : { kind: "package", location: dependency.location };
    return { name: spec.name, packageName, range, kind: spec.kind, resolution };
  });
}
function validTarget(target: NpmInstallTarget): boolean {
  return recordOf(target) && ["win32", "linux", "darwin"].includes(target.os) && ["x64", "arm64"].includes(target.cpu) && exactNpmVersion(target.nodeVersion);
}
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
