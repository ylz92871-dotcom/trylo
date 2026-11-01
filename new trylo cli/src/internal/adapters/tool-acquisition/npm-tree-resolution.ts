import semver from "semver";
import { recordOf } from "../../learning/domains/tool/evolution/parse.js";
import { safePackagePath } from "./npm-quarantine-plan.js";
import { MAX_NPM_TREE_DEPTH, NpmTreeError, type NpmInstallTarget } from "./npm-tree-contract.js";

export function validNpmName(value: unknown): value is string {
  return typeof value === "string" && /^(?:@[a-z0-9][a-z0-9._-]{0,80}\/)?[a-z0-9][a-z0-9._-]{0,80}$/.test(value);
}
export function exactNpmVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && semver.valid(value) === value;
}
export function npmDependency(name: string, raw: unknown): { readonly packageName: string; readonly range: string } {
  if (!validNpmName(name) || typeof raw !== "string" || raw.length > 256) throw new NpmTreeError("unsupported_npm_dependency");
  let packageName = name, range = raw;
  if (raw.startsWith("npm:")) {
    const split = raw.lastIndexOf("@");
    if (split <= 4) throw new NpmTreeError("unsupported_npm_dependency");
    packageName = raw.slice(4, split); range = raw.slice(split + 1);
  }
  if (!validNpmName(packageName) || semver.validRange(range) === null) throw new NpmTreeError("unsupported_npm_dependency");
  return { packageName, range };
}
export function npmVersionSatisfies(version: string, range: string): boolean { return semver.satisfies(version, range); }

/** Validate Node's actual nested node_modules locations, including scoped names. */
export function packageNameAt(location: string): string {
  if (!safePackagePath(location)) throw new NpmTreeError("invalid_npm_location");
  const segments = location.split("/"); let name = "", depth = 0;
  for (let index = 0; index < segments.length;) {
    if (segments[index++] !== "node_modules" || ++depth > MAX_NPM_TREE_DEPTH) throw new NpmTreeError("invalid_npm_location");
    const first = segments[index++];
    if (first === undefined) throw new NpmTreeError("invalid_npm_location");
    name = first.startsWith("@") ? `${first}/${segments[index++] ?? ""}` : first;
    if (!validNpmName(name)) throw new NpmTreeError("invalid_npm_location");
  }
  return name;
}
function parentPackage(location: string): string {
  const split = location.lastIndexOf("/node_modules/"); return split < 0 ? "" : location.slice(0, split);
}
/** Peer dependencies resolve alongside their consumer, never from its private children. */
export function dependencyLocations(location: string, name: string, peer: boolean): readonly string[] {
  const result: string[] = []; let current = peer ? parentPackage(location) : location;
  for (;;) {
    result.push(`${current === "" ? "" : `${current}/`}node_modules/${name}`);
    if (current === "") return result;
    current = parentPackage(current);
  }
}
export function npmPlatformCompatible(metadata: Record<string, unknown>, target: NpmInstallTarget): boolean {
  if (!platformList(metadata.os, target.os) || !platformList(metadata.cpu, target.cpu)) return false;
  if (metadata.libc !== undefined) throw new NpmTreeError("unsupported_npm_dependency");
  return true;
}
function platformList(raw: unknown, value: string): boolean {
  if (raw === undefined) return true;
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list) || list.length > 32 || list.some(item => typeof item !== "string" || item.length > 64)) throw new NpmTreeError("invalid_npm_lock");
  const values = list as string[];
  if (values.length === 1 && values[0] === "any") return true;
  return !values.includes(`!${value}`) && (values.every(item => item.startsWith("!")) || values.includes(value));
}
export function checkNpmNodeEngine(metadata: Record<string, unknown>, target: NpmInstallTarget): void {
  if (metadata.engines === undefined) return;
  if (!recordOf(metadata.engines)) throw new NpmTreeError("invalid_npm_lock");
  const range = metadata.engines.node;
  if (range !== undefined && (typeof range !== "string" || range.length > 256 || semver.validRange(range) === null || !semver.satisfies(target.nodeVersion, range))) throw new NpmTreeError("npm_engine_mismatch");
}
export function checkNpmArchiveIdentity(url: unknown, name: string, version: string): string {
  if (typeof url !== "string" || url.length > 1024) throw new NpmTreeError("unsupported_npm_source");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new NpmTreeError("unsupported_npm_source"); }
  const bare = name.slice(name.lastIndexOf("/") + 1);
  if (parsed.protocol !== "https:" || parsed.hostname !== "registry.npmjs.org" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") throw new NpmTreeError("unsupported_npm_source");
  let decoded: string;
  try { decoded = decodeURIComponent(parsed.pathname); } catch { throw new NpmTreeError("unsupported_npm_source"); }
  if (decoded !== `/${name}/-/${bare}-${version}.tgz`) throw new NpmTreeError("unsupported_npm_source");
  return parsed.toString();
}
