import { contentHashOf } from "../../learning/control/hash.js";

export const MAX_NPM_TREE_PACKAGES = 128;
export const MAX_NPM_LOCK_ENTRIES = 256;
export const MAX_NPM_TREE_DEPTH = 12;

export type NpmInstallTarget = { readonly os: string; readonly cpu: string; readonly nodeVersion: string };
export type NpmDependencyEdge = {
  readonly name: string; readonly packageName: string; readonly range: string; readonly kind: "dependency" | "optional" | "peer" | "optional_peer";
  readonly resolution: { readonly kind: "package"; readonly location: string } | { readonly kind: "omitted"; readonly reason: "not_locked" | "platform_incompatible" };
};
export type NpmLockedPackage = {
  readonly location: string; readonly name: string; readonly version: string; readonly archiveUrl: string; readonly integrity: string;
  readonly edges: readonly NpmDependencyEdge[];
};
/** A resolution plan is not a download, installation receipt, verification or activation. */
export type NpmLockedTree = {
  readonly type: "npm_locked_tree"; readonly schemaVersion: 1; readonly scope: string; readonly target: NpmInstallTarget;
  readonly root: { readonly name: string; readonly version: string; readonly location: string };
  readonly lockHash: string; readonly packages: readonly NpmLockedPackage[]; readonly omittedDev: readonly string[];
  readonly omittedOptional: readonly string[];
};
export function npmTreeId(tree: NpmLockedTree): string { return `npm-tree_v1_${contentHashOf(tree)}`; }
export class NpmTreeError extends Error {
  constructor(readonly code: "invalid_npm_lock" | "invalid_npm_location" | "unsupported_npm_source" | "unsupported_npm_dependency"
    | "npm_tree_limit" | "missing_npm_dependency" | "npm_dependency_mismatch" | "npm_platform_mismatch" | "npm_engine_mismatch"
    | "npm_install_hook_forbidden" | "npm_unreachable_package") { super(code); }
}
