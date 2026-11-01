import { contentHashOf } from "../../learning/control/hash.js";
import { recordOf } from "../../learning/domains/tool/evolution/parse.js";
import type { NpmLockedPackage, NpmLockedTree } from "../../tooling/contract/npm-tree.js";
import type { NpmQuarantinePlan } from "./npm-quarantine-plan.js";
import { safePackagePath } from "./npm-quarantine-plan.js";
import { NpmPackageError, sha256Bytes } from "./npm-package-check.js";
import type { PackageFile } from "./ustar-reader.js";
import { npmPlatformCompatible, checkNpmNodeEngine } from "./npm-tree-resolution.js";
import { npmGithubRepository } from "./npm-repository.js";
import { npmDependencySpecs } from "./npm-dependency-specs.js";

/** Actual archive manifests must independently reproduce every required/optional/peer edge. */
export function checkNpmTreePackage(tree: NpmLockedTree, pkg: NpmLockedPackage, review: NpmQuarantinePlan, files: readonly PackageFile[]): Record<string, unknown> {
  const file = files.find(row => row.path === "package.json");
  if (file === undefined || file.body.length > 262_144 || sha256Bytes(file.body) !== review.manifestSha256) throw new NpmPackageError("manifest_mismatch");
  let manifest: unknown;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.body)); }
  catch { throw new NpmPackageError("manifest_mismatch"); }
  if (!recordOf(manifest) || manifest.name !== pkg.name || manifest.version !== pkg.version || manifest.license !== review.licenseSpdx) throw new NpmPackageError("manifest_mismatch");
  // Older monorepo packages omit repository. Their exact source mapping must be supplied by the review;
  // the checker never upgrades that claim into a verified official identity or verified GitHub commit.
  if (manifest.repository !== undefined && npmGithubRepository(manifest.repository) !== review.upstreamUrl) throw new NpmPackageError("manifest_mismatch");
  if (!npmPlatformCompatible(manifest, tree.target)) throw new NpmPackageError("manifest_mismatch");
  checkNpmNodeEngine(manifest, tree.target);
  checkEdges(manifest, pkg);
  const scripts = manifest.scripts;
  // Registry archives are already packed. prepare/build/publish scripts remain inert reviewed data;
  // installation hooks and native builds are unsupported, and no script is ever invoked here.
  if (scripts !== undefined && (!recordOf(scripts) || ["preinstall", "install", "postinstall"].some(key => Object.hasOwn(scripts, key)))) throw new NpmPackageError("install_hook_forbidden");
  if (manifest.gypfile === true) throw new NpmPackageError("unsupported_dependency_closure");
  for (const key of ["bundleDependencies", "bundledDependencies", "workspaces"]) {
    const value = manifest[key];
    if (value !== undefined && (!Array.isArray(value) || value.length !== 0)) throw new NpmPackageError("unsupported_dependency_closure");
  }
  if (files.some(row => /(^|\/)(?:node_modules|binding\.gyp)(\/|$)|\.(?:node|exe|dll|so|dylib)$/i.test(row.path) || nativeHeader(row.body))) throw new NpmPackageError("unsupported_dependency_closure");
  for (const license of review.licenses) {
    const actual = files.find(row => row.path === license.path);
    if (actual === undefined || sha256Bytes(actual.body) !== license.sha256) throw new NpmPackageError("license_mismatch");
  }
  if (!review.licenses.some(row => /(^|\/)(?:licen[sc]e|copying)(?:[.-][^/]*)?$/i.test(row.path))
    || (review.licenseSpdx === "Apache-2.0" && !review.licenses.some(row => /(^|\/)notice(?:\.[^/]*)?$/i.test(row.path)))) throw new NpmPackageError("license_mismatch");
  return manifest;
}
function nativeHeader(body: Uint8Array): boolean {
  const prefix = Buffer.from(body.subarray(0, 4)).toString("hex");
  return ["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(prefix)
    || (body[0] === 77 && body[1] === 90);
}

function checkEdges(manifest: Record<string, unknown>, pkg: NpmLockedPackage): void {
  const actual = npmDependencySpecs(manifest);
  const expected = pkg.edges.map(({ resolution: _resolution, ...edge }) => edge);
  const order = (rows: typeof actual) => rows.map(row => contentHashOf(row)).sort();
  if (contentHashOf(order(actual)) !== contentHashOf(order(expected))) throw new NpmPackageError("unsupported_dependency_closure");
}

export function npmBin(manifest: Record<string, unknown>, name: string, files: readonly { readonly path: string }[]): string | undefined {
  const defaultName = typeof manifest.name === "string" ? manifest.name.slice(manifest.name.lastIndexOf("/") + 1) : undefined;
  const raw = typeof manifest.bin === "string" ? name === defaultName ? manifest.bin : undefined
    : recordOf(manifest.bin) && Object.hasOwn(manifest.bin, name) ? manifest.bin[name] : undefined;
  const bin = typeof raw === "string" && raw.startsWith("./") ? raw.slice(2) : raw;
  return typeof bin === "string" && safePackagePath(bin) && files.some(file => file.path === bin) ? bin : undefined;
}
