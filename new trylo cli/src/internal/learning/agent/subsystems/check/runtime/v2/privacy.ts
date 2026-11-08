import { findDisclosureRisks } from "../../../../../../compaction/disclosure.js";

/** Reuse the project credential vocabulary. Reject the fact; never relabel a scrubbed sample as the original oracle input. */
export function checkerMaterialHasCredentials(value: unknown): boolean {
  if (typeof value === "string") return findDisclosureRisks(value).some(risk => risk.kind === "secret_shape");
  if (Array.isArray(value)) return value.some(checkerMaterialHasCredentials);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, item]) => (typeof item === "string"
    && findDisclosureRisks(`${key}=${item}`).some(risk => risk.kind === "secret_shape")) || checkerMaterialHasCredentials(item));
}
