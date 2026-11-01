import type { NpmQuarantinePlan } from "./npm-source.js";
import type { NpmLockedTree } from "./npm-tree.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { isJsonValue, jsonBytes, keysAre, recordOf, textOf } from "../../learning/domains/tool/evolution/parse.js";
import { decodeNpmQuarantinePlan, safePackagePath } from "./npm-source.js";

/** Exact reviewed bytes for every runtime location; no installation/verification authority. */
export type NpmInstallPlan = {
  readonly type: "npm_install_plan";
  readonly schemaVersion: 1;
  readonly lock: JsonObject;
  readonly tree: NpmLockedTree;
  readonly packages: readonly { readonly location: string; readonly review: NpmQuarantinePlan }[];
};

export const NPM_INSTALL_MAX_FILES = 16_384;
export const NPM_INSTALL_MAX_BYTES = 64_000_000;
export type NpmInstallFile = { readonly path: string; readonly sha256: string; readonly bytes: number };
export type NpmInstallReceipt = {
  readonly type: "npm_install_receipt"; readonly schemaVersion: 1; readonly planId: string;
  readonly plan: NpmInstallPlan; readonly acquiredAt: string; readonly approvalGrantId: string;
  readonly verification: "not_production_verified"; readonly files: readonly NpmInstallFile[];
};

export function npmInstallId(plan: NpmInstallPlan): string { return `npm-install_v1_${contentHashOf(plan)}`; }

/** Persistence shape boundary only; the adapter independently rebuilds npm resolution before installation/execution. */
export function decodeNpmInstallData(raw: unknown): NpmInstallPlan | undefined {
  if (!isJsonValue(raw, 40) || jsonBytes(raw) > 2 * 1024 * 1024 || !recordOf(raw)
    || !keysAre(raw, ["type", "schemaVersion", "lock", "tree", "packages"]) || raw.type !== "npm_install_plan" || raw.schemaVersion !== 1
    || !recordOf(raw.lock) || !treeShape(raw.tree) || !Array.isArray(raw.packages) || raw.packages.length !== raw.tree.packages.length) return undefined;
  const locations = new Set<string>();
  for (const item of raw.packages) {
    if (!recordOf(item) || !keysAre(item, ["location", "review"]) || typeof item.location !== "string" || locations.has(item.location)) return undefined;
    const pkg = raw.tree.packages.find(row => row.location === item.location), review = decodeNpmQuarantinePlan(item.review);
    if (pkg === undefined || review === undefined || review.name !== pkg.name || review.version !== pkg.version || review.scope !== raw.tree.scope) return undefined;
    locations.add(item.location);
  }
  return structuredClone(raw) as NpmInstallPlan;
}
function treeShape(raw: unknown): raw is NpmLockedTree {
  if (!recordOf(raw) || !keysAre(raw, ["type", "schemaVersion", "scope", "target", "root", "lockHash", "packages", "omittedDev", "omittedOptional"])
    || raw.type !== "npm_locked_tree" || raw.schemaVersion !== 1 || !textOf(raw.scope, 160) || !digest(raw.lockHash)
    || !recordOf(raw.root) || !keysAre(raw.root, ["name", "version", "location"]) || !textOf(raw.root.name, 163) || !textOf(raw.root.version, 80) || !location(raw.root.location)
    || !recordOf(raw.target) || !keysAre(raw.target, ["os", "cpu", "nodeVersion"]) || !textOf(raw.target.os, 16) || !textOf(raw.target.cpu, 16) || !textOf(raw.target.nodeVersion, 80)
    || !Array.isArray(raw.packages) || raw.packages.length === 0 || raw.packages.length > 128 || !raw.packages.every(packageShape)
    || !Array.isArray(raw.omittedDev) || raw.omittedDev.length > 256 || !raw.omittedDev.every(location)
    || !Array.isArray(raw.omittedOptional) || raw.omittedOptional.length > 256 || !raw.omittedOptional.every(location)) return false;
  const paths = new Set(raw.packages.map(row => row.location.toLowerCase())), root = raw.root;
  return paths.size === raw.packages.length && raw.packages.some(row => row.location === root.location && row.name === root.name && row.version === root.version)
    && raw.packages.every(row => row.edges.every(edge => edge.resolution.kind === "omitted" || paths.has(edge.resolution.location.toLowerCase())));
}
function packageShape(raw: unknown): raw is NpmLockedTree["packages"][number] {
  return recordOf(raw) && keysAre(raw, ["location", "name", "version", "archiveUrl", "integrity", "edges"])
    && location(raw.location) && textOf(raw.name, 163) && textOf(raw.version, 80) && textOf(raw.archiveUrl, 1024) && textOf(raw.integrity, 100)
    && Array.isArray(raw.edges) && raw.edges.length <= 384 && raw.edges.every(edge => recordOf(edge) && keysAre(edge, ["name", "packageName", "range", "kind", "resolution"])
      && textOf(edge.name, 163) && textOf(edge.packageName, 163) && textOf(edge.range, 256) && ["dependency", "optional", "peer", "optional_peer"].includes(String(edge.kind))
      && recordOf(edge.resolution) && (edge.resolution.kind === "package" ? keysAre(edge.resolution, ["kind", "location"]) && location(edge.resolution.location)
        : edge.resolution.kind === "omitted" && keysAre(edge.resolution, ["kind", "reason"]) && ["not_locked", "platform_incompatible"].includes(String(edge.resolution.reason))));
}
function location(raw: unknown): raw is string { return typeof raw === "string" && safePackagePath(raw) && raw.startsWith("node_modules/"); }
function digest(raw: unknown): raw is string { return typeof raw === "string" && /^[a-f0-9]{64}$/.test(raw); }
