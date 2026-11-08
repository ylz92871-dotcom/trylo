import type { BoardStore } from "../../../learning/control/store-port.js";
import type { LearningDomain } from "../../../learning/control/contracts.js";
import type { ContentMaterialBatch, ContentMaterialSource, ContentSubsystem } from "../../../learning/central/content/material-contract.js";
import type { ContentArtifactMapping } from "./artifact.js";
import type { NativeKnowledgeAccess } from "./native-knowledge.js";
import type { CentralAdvisorySourceAccess, TaskCentralAdvisory } from "./native-central-advisory.js";

export interface ContentRecallCandidate {
  readonly id: string;
  readonly kind: "public_content" | "asset" | "native_method" | "central_advisory";
  readonly subsystem: ContentSubsystem | "central_advisory";
  readonly sequence: number;
  readonly active: boolean;
  readonly description: string;
  readonly descriptionOmittedChars: number;
  readonly sourceRefs: readonly string[];
}

export interface ContentTaskRecallPort {
  /** Relevance selection only. This cannot merge issues, certify old answers or change source identity. */
  recall(input: { readonly scope: string; readonly taskPurpose: string; readonly candidates: readonly ContentRecallCandidate[];
    readonly omittedCandidates: number; readonly maximumSelected: number }, signal: AbortSignal): Promise<readonly string[]>;
}

export interface BoardTaskReferenceInput {
  readonly board: Pick<BoardStore, "load">;
  readonly scope: string;
  readonly domain: LearningDomain;
  readonly taskPurpose: string;
  readonly enabled: () => boolean;
  readonly recall?: ContentTaskRecallPort;
  readonly maximumCandidates?: number;
  readonly maximumSelected?: number;
  readonly maximumChars?: number;
  readonly nativeAccess?: NativeKnowledgeAccess;
  /** Bound by the normal host to real source owners, never model-supplied access claims. */
  readonly advisoryAccess?: CentralAdvisorySourceAccess;
}

export interface ContentTaskReferenceCoverage {
  readonly scope: string;
  readonly boardSequence: number;
  readonly availableCandidates: number;
  readonly consideredCandidates: number;
  readonly selectedCandidates: readonly string[];
  readonly omittedCandidates: number;
  readonly selection: "semantic_recall" | "lexical_then_scope_recency";
  readonly relevanceIsNotIdentityOrAdequacy: true;
  readonly candidates: readonly ContentRecallCandidate[];
}

export type BoardTaskReferenceRead = { readonly ok: true; readonly value: {
  readonly batch: ContentMaterialBatch;
  readonly source: ContentMaterialSource;
  readonly mappings: readonly ContentArtifactMapping[];
  readonly coverage: ContentTaskReferenceCoverage;
  readonly advisories?: readonly TaskCentralAdvisory[];
  readonly advisoryCatalog?: readonly TaskCentralAdvisory[];
  /** Bounded source data for the normal task model. Delivery and use must be recorded by its host. */
  readonly materialJson: string;
} } | { readonly ok: false; readonly reason: string };
