import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralLearningOpportunity } from "../../learning/central/runtime/contracts.js";
import type { OrganizationKnowledge } from "../../learning/central/organization/contracts.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ProviderMessage } from "../../ports/provider.js";
import type { CentralInputEntry, CentralInputKind } from "./deliberation-input-dictionary.js";
import type { CentralChangeReferenceCategory } from "./change-reference-contract.js";

/** Pins both instruction bytes and read-capability projection for receipt replay. */
export const LEGACY_CENTRAL_CHANGE_INPUT_VERSION = "central-learning-change-input-v1";
export const PREVIOUS_CENTRAL_CHANGE_INPUT_VERSION = "central-learning-change-input-v2";
export const C18_CENTRAL_CHANGE_INPUT_VERSION = "central-learning-change-input-v3";
export const C34_CENTRAL_CHANGE_INPUT_VERSION = "central-learning-change-input-v4";
export const PURPOSE_SOURCE_CENTRAL_CHANGE_INPUT_VERSION = "central-learning-change-input-v5";
export const COMPLETED_READ_CENTRAL_CHANGE_INPUT_VERSION = "central-learning-change-input-v6";
export const CENTRAL_CHANGE_INPUT_VERSION = "central-learning-change-input-v7";

export type CentralChangeInputVersion = typeof LEGACY_CENTRAL_CHANGE_INPUT_VERSION
  | typeof PREVIOUS_CENTRAL_CHANGE_INPUT_VERSION | typeof C18_CENTRAL_CHANGE_INPUT_VERSION | typeof C34_CENTRAL_CHANGE_INPUT_VERSION
  | typeof PURPOSE_SOURCE_CENTRAL_CHANGE_INPUT_VERSION | typeof COMPLETED_READ_CENTRAL_CHANGE_INPUT_VERSION | typeof CENTRAL_CHANGE_INPUT_VERSION;

export type CentralShortReferenceInputVersion = typeof C34_CENTRAL_CHANGE_INPUT_VERSION
  | typeof PURPOSE_SOURCE_CENTRAL_CHANGE_INPUT_VERSION | typeof COMPLETED_READ_CENTRAL_CHANGE_INPUT_VERSION | typeof CENTRAL_CHANGE_INPUT_VERSION;

export function isCentralChangeInputVersion(value: unknown): value is CentralChangeInputVersion {
  return value === LEGACY_CENTRAL_CHANGE_INPUT_VERSION || value === PREVIOUS_CENTRAL_CHANGE_INPUT_VERSION
    || value === C18_CENTRAL_CHANGE_INPUT_VERSION || value === C34_CENTRAL_CHANGE_INPUT_VERSION
    || value === PURPOSE_SOURCE_CENTRAL_CHANGE_INPUT_VERSION || value === COMPLETED_READ_CENTRAL_CHANGE_INPUT_VERSION || value === CENTRAL_CHANGE_INPUT_VERSION;
}

/** Historical encodings are fixed even after a future current version changes. */
export function usesCentralShortReferenceHandles(inputVersion: CentralChangeInputVersion):
  inputVersion is CentralShortReferenceInputVersion {
  return inputVersion === C34_CENTRAL_CHANGE_INPUT_VERSION || inputVersion === PURPOSE_SOURCE_CENTRAL_CHANGE_INPUT_VERSION
    || inputVersion === COMPLETED_READ_CENTRAL_CHANGE_INPUT_VERSION || inputVersion === CENTRAL_CHANGE_INPUT_VERSION;
}

/** A source projection is pinned independently of whichever version is current. */
export function usesCentralSourceProjectionV5(inputVersion: CentralChangeInputVersion): boolean {
  return inputVersion === PURPOSE_SOURCE_CENTRAL_CHANGE_INPUT_VERSION || inputVersion === COMPLETED_READ_CENTRAL_CHANGE_INPUT_VERSION
    || inputVersion === CENTRAL_CHANGE_INPUT_VERSION;
}

export interface CentralChangeInputDictionary {
  readonly checkpoint: string;
  readonly entries: readonly CentralInputEntry[];
  handleKind?(handle: string): CentralInputKind | undefined;
  selectionHandles?(category: CentralChangeReferenceCategory): readonly string[];
  readonly referenceSelectionContractRef?: string;
  readonly selectionCode?: string;
  /** Call once at the synchronous compiler boundary before indexed expansion. */
  assertRequest(request: CentralDeliberationRequest): void;
  source(handle: string): string | undefined;
  read(handle: string): string | undefined;
  intent(handle: string): CentralLearningIntentDraft | undefined;
  opportunity(handle: string): CentralLearningOpportunity | undefined;
  citation(handle: string, quote?: string): { readonly evidenceRef: string; readonly quote: string } | undefined;
  recall(handle: string): string | undefined;
  knowledge(handle: string): { readonly factId: string; readonly knowledge: OrganizationKnowledge } | undefined;
  feedback(handle: string): string | undefined;
}

export interface CentralChangeExposure {
  readonly ref: string;
  readonly kind: "body" | "navigation" | "control";
  readonly textHash: string;
  readonly readRefs: readonly string[];
}

export interface CentralChangeInput {
  readonly version: CentralChangeInputVersion;
  readonly checkpoint: string;
  readonly view: JsonObject;
  /** Only the public data message. Sol06 owns the system instruction and tools. */
  readonly messages: readonly ProviderMessage[];
  readonly dictionary: CentralChangeInputDictionary;
  readonly exposure: readonly CentralChangeExposure[];
}

export type CentralChangeInputRenderer = (request: CentralDeliberationRequest) => CentralChangeInput;
