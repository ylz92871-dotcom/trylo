import { createHash } from "node:crypto";
import { recordOf } from "../../learning/domains/tool/evolution/parse.js";
import type { NpmQuarantinePlan } from "./npm-quarantine-plan.js";
import { safePackagePath } from "./npm-quarantine-plan.js";
import type { PackageFile } from "./ustar-reader.js";

export class NpmPackageError extends Error {
  constructor(readonly code: "manifest_mismatch" | "unsupported_dependency_closure" | "install_hook_forbidden" | "license_mismatch" | "invalid_entrypoint") { super(code); }
}
export const sha256Bytes = (body: Uint8Array): string => createHash("sha256").update(body).digest("hex");

/** First install profile is dependency-free npm CLI packages, never npm install or lifecycle scripts. */
export function checkNpmPackage(plan: NpmQuarantinePlan, files: readonly PackageFile[]): readonly string[] {
  const manifestFile = files.find(file => file.path === "package.json");
  if (manifestFile === undefined || manifestFile.body.length > 262_144 || sha256Bytes(manifestFile.body) !== plan.manifestSha256) throw new NpmPackageError("manifest_mismatch");
  let manifest: unknown;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.body)); }
  catch { throw new NpmPackageError("manifest_mismatch"); }
  if (!recordOf(manifest) || manifest.name !== plan.name || manifest.version !== plan.version || manifest.license !== plan.licenseSpdx) throw new NpmPackageError("manifest_mismatch");
  const repo = recordOf(manifest.repository) ? manifest.repository.url : manifest.repository;
  if (typeof repo !== "string" || repo.replace(/^git\+/, "").replace(/\.git$/, "") !== plan.upstreamUrl) throw new NpmPackageError("manifest_mismatch");
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = manifest[key];
    if (deps !== undefined && (!recordOf(deps) || Object.keys(deps).length !== 0)) throw new NpmPackageError("unsupported_dependency_closure");
  }
  for (const key of ["bundledDependencies", "bundleDependencies", "workspaces"]) {
    const deps = manifest[key];
    if (deps !== undefined && (!Array.isArray(deps) || deps.length !== 0)) throw new NpmPackageError("unsupported_dependency_closure");
  }
  if (files.some(file => /(^|\/)(?:node_modules|binding\.gyp)(\/|$)/i.test(file.path))) throw new NpmPackageError("unsupported_dependency_closure");
  const scripts = manifest.scripts;
  if (scripts !== undefined && (!recordOf(scripts) || ["preinstall", "install", "postinstall", "prepare"].some(key => Object.hasOwn(scripts, key)))) throw new NpmPackageError("install_hook_forbidden");
  for (const item of plan.licenses) {
    const file = files.find(entry => entry.path === item.path);
    if (file === undefined || sha256Bytes(file.body) !== item.sha256) throw new NpmPackageError("license_mismatch");
  }
  if (plan.licenseSpdx === "Apache-2.0" && !plan.licenses.some(item => /(^|\/)notice(?:\.[^.]+)?$/i.test(item.path))) throw new NpmPackageError("license_mismatch");
  const entries = typeof manifest.bin === "string" ? [manifest.bin] : recordOf(manifest.bin) ? Object.values(manifest.bin) : [];
  if (entries.length === 0 || entries.length > 16 || entries.some(entry => typeof entry !== "string" || !safePackagePath(entry) || !files.some(file => file.path === entry))) throw new NpmPackageError("invalid_entrypoint");
  return entries as string[];
}
