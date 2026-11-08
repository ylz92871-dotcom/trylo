import { fields, sequence } from "../../../validation/json-shape.js";

export const CENTRAL_DERIVED_INTENT_CITATION_REJECTION_REASON = "central_derived_intent_citation_unread_or_not_unique";

/** Positions identify the rejected slot without retaining source identities or quotation text. */
export interface CentralCitationRejection {
  readonly schemaVersion: 1;
  readonly slot: "intent_derivation_citation";
  readonly intentIndex: number;
  readonly citationIndex: number;
  readonly cause: "material_not_supplied" | "body_unread" | "quote_empty" | "quote_not_found"
    | "quote_not_unique" | "evidence_not_parent";
}

export function isCentralCitationRejection(value: unknown): value is CentralCitationRejection {
  return fields(value, ["schemaVersion", "slot", "intentIndex", "citationIndex", "cause"])
    && Reflect.ownKeys(value).length === 5
    && value.schemaVersion === 1 && value.slot === "intent_derivation_citation"
    && sequence(value.intentIndex) && sequence(value.citationIndex)
    && (value.cause === "material_not_supplied" || value.cause === "body_unread" || value.cause === "quote_empty"
      || value.cause === "quote_not_found" || value.cause === "quote_not_unique" || value.cause === "evidence_not_parent");
}
