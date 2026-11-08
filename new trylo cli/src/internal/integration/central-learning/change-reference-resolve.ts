import type { CentralInputKind } from "./deliberation-input-dictionary.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { centralReferenceKinds, centralReferenceSelectionCode,
  type CentralChangeReferenceCategory, type CentralChangeReferenceRejection } from "./change-reference-contract.js";

export interface CentralReferenceResolverDictionary {
  readonly checkpoint: string;
  readonly referenceSelectionContractRef?: string;
  handleKind?(handle: string): CentralInputKind | undefined;
}

/** Report only the failed mechanical binding. Original accessors own resolution. */
export function bindCentralChangeReference<T>(dictionary: CentralReferenceResolverDictionary, resolved: T | undefined,
  context: { readonly field: string; readonly handle: string; readonly category: CentralChangeReferenceCategory;
    readonly quoteProvided?: boolean }): T {
  if (resolved !== undefined) return resolved;

  if (typeof dictionary.handleKind !== "function") {
    throw new CentralDeliberationError("central_learning_change_handle_unbound", "returned");
  }

  const actual = dictionary.handleKind(context.handle), expected = centralReferenceKinds(context.category);
  let field = context.field;
  let cause: CentralChangeReferenceRejection["cause"] = actual === undefined ? "unknown_handle"
    : !expected.includes(actual) ? "kind_mismatch" : "unavailable_handle";

  if (context.category === "citation" && actual !== undefined && expected.includes(actual)) {
    if (context.quoteProvided === true) cause = "quote_not_exact";
    else if (actual === "source") cause = "quote_required";
    if (cause === "quote_not_exact" || cause === "quote_required") field = field.replace(/\/source$/, "/quote");
  }

  const rejection: CentralChangeReferenceRejection = { schemaVersion: 1, field, expected, actual: actual ?? "unknown", cause,
    ...(actual === undefined ? {} : { handle: context.handle }) };
  throw new CentralDeliberationError("central_learning_change_handle_unbound", "returned",
    undefined, undefined, undefined, undefined, rejection);
}

/** The short wire code does not replace the original private request binding. */
export function validateCentralChangeSelection(dictionary: CentralReferenceResolverDictionary, provided: string | undefined,
  mode: "legacy" | "selection_code"): void {
  if (mode === "legacy") {
    if (provided !== undefined && provided !== dictionary.checkpoint) {
      throw new CentralDeliberationError("central_learning_change_invalid", "returned");
    }
    return;
  }

  const selectionCode = centralReferenceSelectionCode(dictionary);
  if (selectionCode !== undefined && provided === selectionCode) return;

  const rejection: CentralChangeReferenceRejection = { schemaVersion: 1, field: "/checkpoint", expected: ["checkpoint"],
    actual: "unknown", cause: provided === undefined ? "checkpoint_missing" : "checkpoint_mismatch" };
  throw new CentralDeliberationError("central_learning_change_invalid", "returned",
    undefined, undefined, undefined, undefined, rejection);
}
