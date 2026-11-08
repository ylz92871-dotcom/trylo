import { canonicalJson, contentHashOf } from "../../control/hash.js";
import { isRewardV2Draft, type RewardV2Draft, type RewardV2Fact } from "../../reward/v2-facts.js";
import { fields, identity } from "../../../validation/json-shape.js";
import type { CentralRuntimeMaterial } from "./contracts.js";
import { isCentralRuntimeMaterial } from "./validation.js";

// Separate from the checkpoint algorithm so an already running older reader
// ignores the new immutable archive instead of treating it as a corrupt head.
export const CENTRAL_RUNTIME_MATERIAL_ALGORITHM = "central-learning-material-archive-v1";

/** Original source storage only: no semantic head, delivery acknowledgement,
 * completed operation, budget, permission or learning outcome is created. */
export function buildCentralRuntimeMaterialRecord(scope: string, material: CentralRuntimeMaterial): RewardV2Draft {
  if (!identity(scope) || !isCentralRuntimeMaterial(material)) throw new Error("central_runtime_material_record_invalid");
  const payloadJson = canonicalJson({ schemaVersion: 1, type: "central_learning_original_material", scope, material });
  const fact: RewardV2Draft = { id: `central-runtime-material:${contentHashOf(payloadJson)}`, scope,
    algorithmVersion: CENTRAL_RUNTIME_MATERIAL_ALGORITHM, kind: "projection", payloadJson };
  if (!isRewardV2Draft(fact)) throw new Error("central_runtime_material_record_capacity");
  return fact;
}

export function readCentralRuntimeMaterialRecord(fact: RewardV2Fact): CentralRuntimeMaterial {
  if (!fields(fact, ["id", "scope", "algorithmVersion", "kind", "payloadJson", "sequence"])) {
    throw new Error("central_runtime_material_record_corrupt");
  }

  let raw: unknown;

  try { raw = JSON.parse(fact.payloadJson); } catch { throw new Error("central_runtime_material_record_corrupt"); }

  if (!fields(raw, ["schemaVersion", "type", "scope", "material"]) || raw.schemaVersion !== 1
    || raw.type !== "central_learning_original_material" || raw.scope !== fact.scope || !isCentralRuntimeMaterial(raw.material)) {
    throw new Error("central_runtime_material_record_corrupt");
  }

  const original = buildCentralRuntimeMaterialRecord(fact.scope, raw.material);
  if (fact.id !== original.id || fact.kind !== original.kind || fact.algorithmVersion !== original.algorithmVersion
    || fact.payloadJson !== original.payloadJson) throw new Error("central_runtime_material_record_corrupt");

  return raw.material;
}
