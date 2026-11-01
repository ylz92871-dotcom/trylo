import { recordOf } from "../../learning/domains/tool/evolution/parse.js";
import type { NpmDependencyEdge } from "../../tooling/contract/npm-tree.js";
import { NpmTreeError } from "./npm-tree-contract.js";
import { npmDependency } from "./npm-tree-resolution.js";

export type NpmDependencySpec = Omit<NpmDependencyEdge, "resolution">;

/** One normalization for lock metadata and actual archive manifests, including alias and peer semantics. */
export function npmDependencySpecs(metadata: Record<string, unknown>): readonly NpmDependencySpec[] {
  const required = dependencyMap(metadata.dependencies), optional = dependencyMap(metadata.optionalDependencies), peers = dependencyMap(metadata.peerDependencies);
  const specs: NpmDependencySpec[] = [];
  for (const [name, raw] of Object.entries({ ...required, ...optional })) specs.push({ name, ...npmDependency(name, raw), kind: Object.hasOwn(optional, name) ? "optional" : "dependency" });
  const meta = metadata.peerDependenciesMeta;
  if (meta !== undefined && !recordOf(meta)) throw new NpmTreeError("invalid_npm_lock");
  for (const [name, raw] of Object.entries(peers)) {
    const item = recordOf(meta) ? meta[name] : undefined;
    if (item !== undefined && (!recordOf(item) || (item.optional !== undefined && typeof item.optional !== "boolean"))) throw new NpmTreeError("invalid_npm_lock");
    specs.push({ name, ...npmDependency(name, raw), kind: recordOf(item) && item.optional === true ? "optional_peer" : "peer" });
  }
  return specs.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
}
function dependencyMap(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!recordOf(raw) || Object.keys(raw).length > 128) throw new NpmTreeError("invalid_npm_lock");
  return raw;
}
