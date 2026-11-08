import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson } from "../../learning/control/hash.js";
import type { CentralAdvisoryPublicationView } from "./central-advisory-contracts.js";
import { readCentralAdvisory } from "./central-advisory-records.js";
import { readCentralAdvisoryPublicationSource } from "./central-advisory-source-binding.js";
import { CentralAdvisorySourceError, collectCentralAdvisoryAccessSourceInventory, type CentralAdvisoryAccessSourceInventory } from "./central-advisory-source-ancestry.js";

const fail = (): never => { throw new CentralAdvisorySourceError("central_advisory_access_source_binding_invalid"); };
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

/** Re-derive the published access ancestry from the original applied decision.
 * The destination source owner still decides access; this facade supplies no
 * ACL, session membership, publication permission or activation authority. */
export function readCentralAdvisoryAccessSourceInventory(board: BoardState, scope: string,
  publication: CentralAdvisoryPublicationView): CentralAdvisoryAccessSourceInventory {
  const original = readCentralAdvisory(board, scope, { ref: publication.id, version: publication.version });
  if (original === undefined || !same(original, publication)) return fail();

  const source = readCentralAdvisoryPublicationSource(board, scope, publication.version);
  if (source === undefined) return fail();

  const inventory = collectCentralAdvisoryAccessSourceInventory(board, scope, source);
  if (!same(source.value.accessSourceRefs, inventory.sourceRefs)) return fail();

  return inventory;
}
