import { err, ok, type Result } from "../../../../../../tooling/contract/result.js";
import type { ToolCandidate } from "../../../../../../tooling/contract/types.js";

export type DiscoveryHit = {
  readonly candidate: ToolCandidate;
  readonly sourceIndex: string;
};

export type DiscoveryPort = {
  readonly search: (capability: string) => Result<readonly DiscoveryHit[], "discovery_failed">;
};

export function createFakeDiscoveryPort(index: readonly ToolCandidate[]): DiscoveryPort {
  return {
    search(capability: string) {
      if (capability.length === 0) {
        return err("discovery_failed", "capability query is required");
      }

      const hits = index.filter((candidate) =>
        candidate.capabilities.some((item) => item === capability || item.includes(capability)),
      );

      return ok(
        hits.map((candidate) => ({
          candidate,
          sourceIndex: "testdata/tool-learning/discovery-index.json",
        })),
      );
    },
  };
}

export function normalizeHits(hits: readonly DiscoveryHit[]): readonly ToolCandidate[] {
  return hits.map((hit) => {
    const unverifiable = hit.candidate.unverifiableFields.length > 0
      ? hit.candidate.unverifiableFields
      : ["starCount"];
    return {
      ...hit.candidate,
      unverifiableFields: unverifiable,
    };
  });
}
