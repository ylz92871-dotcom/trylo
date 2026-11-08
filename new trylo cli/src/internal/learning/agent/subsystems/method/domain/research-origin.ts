import { fields, text } from "../../../../../validation/json-shape.js";
import type { MethodLineage } from "./contracts.js";

export type CentralResearchMethodOrigin = Extract<MethodLineage["createdFrom"], { readonly kind: "central_research" }>;

/** A research request is an actual source identity, never a fabricated failed
 * task or tool beat. Old task-derived cards retain their original contract. */
export function isCentralResearchMethodOrigin(value: unknown): value is CentralResearchMethodOrigin {
  return fields(value, ["kind", "requestRef", "checkpointRef", "reservationId"]) && value.kind === "central_research"
    && [value.requestRef, value.checkpointRef, value.reservationId].every(item => text(item, 256));
}

export function methodOriginTaskId(origin: MethodLineage["createdFrom"]): string | undefined {
  return "turnId" in origin ? origin.turnId : undefined;
}
