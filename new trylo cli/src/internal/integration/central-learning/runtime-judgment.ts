import type { CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { CENTRAL_JUDGMENT_VIEW_PREFIX, createCentralJudgmentMaterial, readCentralJudgmentMaterial } from "../../learning/central/runtime/judgment.js";
import { mergeRuntimeMaterials } from "../../learning/central/runtime/transitions.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { createCentralJudgmentProvenanceReader } from "./runtime-judgment-provenance.js";

/** A semantic result identity still names the exact original output. Its public
 * explanation is a decision record, never host-authenticated learned knowledge. */
export function centralJudgmentResultMaterial(input: { readonly scope: string; readonly operationId: string;
  readonly resultRef: string; readonly original: CentralRuntimeMaterial }): CentralRuntimeMaterial {
  return createCentralJudgmentMaterial({ scope: input.scope, operationId: input.operationId, resultRef: input.resultRef,
    originalRef: input.original.ref, originalHash: contentHashOf(input.original), text: input.original.text,
    sourceRefs: input.original.sourceRefs, aliases: [input.original.ref] });
}

/** Only current delivery is projected. Originals remain byte-for-byte available
 * at their old identities; a new strict view is the role/version boundary. */
export function createCentralJudgmentProjection(input: { readonly facts: readonly RewardV2Fact[];
  readonly scope: string; readonly boardSequence: number }) {
  const origin = createCentralJudgmentProvenanceReader(input);
  const unconfirmed = (material: CentralRuntimeMaterial) => Object.assign(new CentralDeliberationError("central_judgment_provenance_unconfirmed"),
    { materialRef: material.ref, materialHash: contentHashOf(material) });
  const materials = (originals: readonly CentralRuntimeMaterial[]): readonly CentralRuntimeMaterial[] => {
    const views: CentralRuntimeMaterial[] = [];

    for (const material of originals) {
      const existing = readCentralJudgmentMaterial(material);
      if (existing !== undefined) {
        if (existing.scopeHash !== contentHashOf(input.scope)) throw unconfirmed(material);
        continue;
      }

      if (material.ref.startsWith(CENTRAL_JUDGMENT_VIEW_PREFIX)) throw unconfirmed(material);

      let found;

      try { found = origin(material); }
      catch (error) {
        if (error instanceof Error && error.message === "central_judgment_provenance_unconfirmed") {
          throw unconfirmed(material);
        }
        throw error;
      }

      if (found !== undefined) views.push(createCentralJudgmentMaterial({ scope: input.scope,
        operationId: found.operationId, resultRef: found.resultRef, originalRef: found.originalRef,
        originalHash: found.originalHash, text: found.text, sourceRefs: found.sourceRefs, aliases: found.aliases }));
    }

    return views.length === 0 ? originals : mergeRuntimeMaterials(originals, views);
  };
  const request = (original: CentralDeliberationRequest): CentralDeliberationRequest => {
    if (original.scope !== input.scope) throw new CentralDeliberationError("central_judgment_scope_mismatch");
    const projected = { ...original, materials: materials(original.materials), organization: materials(original.organization),
      state: { ...original.state, materials: materials(original.state.materials) } };
    return canonicalJson(projected) === canonicalJson(original) ? original : projected;
  };

  return Object.freeze({ materials, request });
}

/** One read of the original Board builds an ephemeral provenance join. This
 * creates no source, wake, index ledger, funding reservation or provider call. */
export async function readCentralJudgmentProjection(input: { readonly boardRoot: string; readonly scope: string;
  readonly enabled: () => boolean }) {
  const board = await createRewardV2BoardPort(input.boardRoot, input.enabled).read();
  if (!input.enabled()) throw new CentralDeliberationError("central_deliberation_cancelled");
  return createCentralJudgmentProjection({ facts: board.facts, scope: input.scope, boardSequence: board.revision });
}
