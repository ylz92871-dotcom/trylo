import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { text } from "../../validation/json-shape.js";
import { CENTRAL_REFERENCE_SELECTION_CONTRACT_REF, centralReferenceSelectionCode } from "./change-reference-contract.js";

export type CentralInputKind = "source" | "read" | "intent" | "operation" | "opportunity"
  | "organization_recall" | "organization_feedback" | "organization_knowledge" | "organization_revision" | "reference" | "span";

export interface CentralInputEntryInput { readonly kind: CentralInputKind; readonly ref: string }

export interface CentralInputEntry extends CentralInputEntryInput { readonly handle: string }

export interface CentralInputDictionary {
  readonly checkpoint: string;
  readonly entries: readonly CentralInputEntry[];
  readonly referenceSelectionContractRef?: string;
  readonly selectionCode?: string;
}

export type BoundCentralInputResolver = (handle: string, allowedKind: CentralInputKind | readonly CentralInputKind[]) => string;

export type CentralInputDictionaryFailure = "central_input_dictionary_invalid" | "central_input_request_invalid"
  | "central_input_checkpoint_mismatch" | "central_input_kind_invalid" | "central_input_reference_invalid"
  | "central_input_entry_unknown" | "central_input_handle_unknown" | "central_input_handle_kind_mismatch";

export class CentralInputDictionaryError extends Error {
  constructor(readonly reason: CentralInputDictionaryFailure) {
    super(reason);
    this.name = "CentralInputDictionaryError";
  }
}

const codes: Readonly<Record<CentralInputKind, string>> = Object.freeze({ source: "b", read: "r", intent: "i", operation: "o",
  opportunity: "p", organization_recall: "c", organization_feedback: "f", organization_knowledge: "k",
  organization_revision: "v", reference: "e", span: "s" });

// A dictionary is authority for this rendering only. Serialized tables may be
// compared with a deterministic re-render, but cannot authorize resolution.
interface DictionaryAuthority {
  readonly checkpoint: string;
  readonly byHandle: ReadonlyMap<string, CentralInputEntry>;
  readonly byTypedRef: ReadonlyMap<string, CentralInputEntry>;
}

const authorities = new WeakMap<CentralInputDictionary, DictionaryAuthority>();

function fail(reason: CentralInputDictionaryFailure): never { throw new CentralInputDictionaryError(reason); }

function kind(value: unknown): value is CentralInputKind {
  return typeof value === "string" && Object.hasOwn(codes, value);
}

function checkpoint(request: CentralDeliberationRequest): string {
  if (request === null || typeof request !== "object") return fail("central_input_request_invalid");
  try { return `central-input-checkpoint:${contentHashOf(request)}`; }
  catch { return fail("central_input_request_invalid"); }
}

function authorityOf(dictionary: CentralInputDictionary): DictionaryAuthority {
  if (dictionary === null || typeof dictionary !== "object") fail("central_input_dictionary_invalid");
  return authorities.get(dictionary) ?? fail("central_input_dictionary_invalid");
}

const typedRef = (entryKind: CentralInputKind, ref: string): string => `${entryKind}\u0000${ref}`;

/** The caller classifies only the exact packed input. This module neither
 * discovers sources nor promotes an address, alias or span to evidence. */
export function createCentralInputDictionary(request: CentralDeliberationRequest,
  entries: readonly CentralInputEntryInput[], encoding: "checkpoint" | "typed_decimal" = "checkpoint"): CentralInputDictionary {
  const bound = checkpoint(request), prefix = bound.slice("central-input-checkpoint:".length, "central-input-checkpoint:".length + 12);

  if (!Array.isArray(entries) || encoding !== "checkpoint" && encoding !== "typed_decimal") return fail("central_input_dictionary_invalid");

  const selected: CentralInputEntry[] = [], byHandle = new Map<string, CentralInputEntry>(), byTypedRef = new Map<string, CentralInputEntry>();
  const counts = new Map<CentralInputKind, number>();

  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") fail("central_input_kind_invalid");

    const entryKind: unknown = entry.kind, ref: unknown = entry.ref;
    if (!kind(entryKind)) fail("central_input_kind_invalid");

    if (!text(ref, 8192) || /[\u0000-\u001f]/.test(ref)) fail("central_input_reference_invalid");

    const identity = typedRef(entryKind, ref);
    if (byTypedRef.has(identity)) continue;

    const ordinal = (counts.get(entryKind) ?? 0) + 1;
    counts.set(entryKind, ordinal);
    const handle = encoding === "typed_decimal" ? `${codes[entryKind]}${ordinal}`
      : `${codes[entryKind]}${prefix}_${(selected.length + 1).toString(36)}`;
    const value = Object.freeze({ handle, kind: entryKind, ref });

    selected.push(value);
    byHandle.set(value.handle, value);
    byTypedRef.set(identity, value);
  }

  const selection: Pick<CentralInputDictionary, "referenceSelectionContractRef"> = encoding === "typed_decimal"
    ? { referenceSelectionContractRef: CENTRAL_REFERENCE_SELECTION_CONTRACT_REF } : {};
  const selectionCode = centralReferenceSelectionCode({ checkpoint: bound, ...selection });
  const dictionary: CentralInputDictionary = Object.freeze({ checkpoint: bound, entries: Object.freeze(selected), ...selection,
    ...(selectionCode === undefined ? {} : { selectionCode }) });

  authorities.set(dictionary, { checkpoint: bound, byHandle, byTypedRef });

  return dictionary;
}

export function centralInputHandle(dictionary: CentralInputDictionary, entryKind: CentralInputKind, ref: string): string {
  const authority = authorityOf(dictionary);
  if (!kind(entryKind)) return fail("central_input_kind_invalid");
  if (typeof ref !== "string") return fail("central_input_reference_invalid");
  const entry = authority.byTypedRef.get(typedRef(entryKind, ref));
  return entry?.handle ?? fail("central_input_entry_unknown");
}

/** Bind once at entry to one synchronous compilation. Immutable private indexes
 * serve all subsequent lookups; no request or table is hashed per handle. */
export function bindCentralInputDictionary(request: CentralDeliberationRequest,
  dictionary: CentralInputDictionary): BoundCentralInputResolver {
  const authority = authorityOf(dictionary);
  if (checkpoint(request) !== authority.checkpoint) return fail("central_input_checkpoint_mismatch");

  return (handle, allowedKind) => {
    const allowed = Array.isArray(allowedKind) ? allowedKind : [allowedKind];
    if (allowed.length === 0 || !allowed.every(kind)) return fail("central_input_kind_invalid");
    const entry = authority.byHandle.get(handle);
    if (entry === undefined) return fail("central_input_handle_unknown");
    if (!allowed.includes(entry.kind)) return fail("central_input_handle_kind_mismatch");
    return entry.ref;
  };
}

export function resolveCentralInputHandle(request: CentralDeliberationRequest, dictionary: CentralInputDictionary,
  handle: string, allowedKind: CentralInputKind | readonly CentralInputKind[]): string {
  return bindCentralInputDictionary(request, dictionary)(handle, allowedKind);
}
