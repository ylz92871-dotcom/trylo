import { createHash } from "node:crypto";
import type { NpmInstallPlan, NpmInstallFile } from "../../tooling/contract/npm-install.js";
import { NPM_INSTALL_MAX_BYTES, NPM_INSTALL_MAX_FILES } from "../../tooling/contract/npm-install.js";
import { NpmPackageError, sha256Bytes } from "./npm-package-check.js";
import { readNpmTarball, type PackageFile } from "./ustar-reader.js";
import { checkNpmTreePackage } from "./npm-tree-package-check.js";
import { safePackagePath } from "./npm-quarantine-plan.js";

/** No extracted manifest or mutable receipt may replace the reviewed tarball as source authority. */
export function inspectNpmInstallContent(plan: NpmInstallPlan, archives: ReadonlyMap<string, Uint8Array>): readonly PackageFile[] {
  const files: PackageFile[] = [], paths = new Set<string>(); let bytes = 0;
  for (const pkg of plan.tree.packages) {
    const review = plan.packages.find(row => row.location === pkg.location)?.review, body = archives.get(pkg.location);
    if (review === undefined || body === undefined || sha256Bytes(body) !== review.sha256
      || `sha512-${createHash("sha512").update(body).digest("base64")}` !== pkg.integrity) throw new NpmPackageError("manifest_mismatch");
    const contents = readNpmTarball(body, review.sha256, "dependency_tree");
    checkNpmTreePackage(plan.tree, pkg, review, contents);
    for (const file of contents) {
      const relative = `${pkg.location}/${file.path}`;
      if (!safePackagePath(relative) || paths.has(relative.toLowerCase())) throw new NpmPackageError("unsupported_dependency_closure");
      bytes += file.body.length; paths.add(relative.toLowerCase());
      if (bytes > NPM_INSTALL_MAX_BYTES || files.length >= NPM_INSTALL_MAX_FILES) throw new NpmPackageError("unsupported_dependency_closure");
      files.push({ path: relative, body: file.body });
    }
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function npmInstallFileIndex(files: readonly PackageFile[]): readonly NpmInstallFile[] {
  return files.map(file => ({ path: file.path, sha256: sha256Bytes(file.body), bytes: file.body.length }));
}
