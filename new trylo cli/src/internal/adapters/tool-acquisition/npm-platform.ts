import type { NpmInstallTarget } from "../../tooling/contract/npm-tree.js";

/** Process facts are sampled once at composition, never supplied by a package manifest. */
export function hostNpmTarget(facts: NpmInstallTarget = { os: process.platform, cpu: process.arch, nodeVersion: process.versions.node }): NpmInstallTarget {
  return { ...facts };
}
