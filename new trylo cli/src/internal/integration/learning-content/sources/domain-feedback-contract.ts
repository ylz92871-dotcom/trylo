import type { CentralLearningContextReader } from "../../../learning/control/source-context.js";
import type { LearningDomain } from "../../../learning/control/contracts.js";
import type { ContentMaterialBatch } from "../../../learning/central/content/material-contract.js";
import type { ContentMaterialPage } from "./artifact-read.js";
import type { ContentDomainFeedbackReader } from "./domain-feedback-basis.js";
import type { BoardState } from "../../../learning/control/state.js";
import type { CentralLearningAgentDomain } from "../../../learning/control/coordination-contract.js";

export const MAX_DOMAIN_FEEDBACK_MATERIAL_CHARS = 60000;

/** Original-owner discovery metadata only. Delivery proves exposure, adoption
 * proves its recorded use, and neither certifies benefit or causal quality. */
export interface ContentDomainFeedbackChange {
  readonly domain: CentralLearningAgentDomain;
  readonly issueId: string;
  readonly factRef: string;
  readonly unitRef: string;
  /** Original immutable fact/event/revision identity, never the current Board prefix. */
  readonly revisionRef: string;
  readonly kind: "delivery" | "adoption" | "quality" | "correction" | "approval" | "dependency";
  readonly sourceRefs: readonly string[];
}

/** Pure batch metadata over the already loaded original Board. Workspace
 * identity belongs to the host closure; full owner bodies are read separately. */
export type ContentDomainFeedbackChangesReader = (board: BoardState, input: { readonly scope: string }) =>
  readonly ContentDomainFeedbackChange[];

export interface DomainFeedbackMaterialInput {
  readonly reader?: CentralLearningContextReader;
  readonly domainFeedback?: ContentDomainFeedbackReader;
  readonly board?: BoardState;
  readonly issueIds: readonly string[];
  readonly scope: string;
  readonly domain: LearningDomain;
  readonly signal: AbortSignal;
  readonly maximumChars?: number;
  readonly secrets?: readonly string[];
}

export interface DomainFeedbackMaterialCoverage {
  readonly requestedIssueIds: readonly string[];
  readonly absentIssueIds: readonly string[];
  readonly frames: readonly { readonly issueIds: readonly string[]; readonly ref: string; readonly sourceHash: string;
    readonly totalChars: number; readonly transport: "inline" | "manifest" | "deferred" }[];
  readonly gaps: readonly { readonly issueId: string; readonly reason: "reader_failed" | "frame_invalid" | "source_ref_conflict" }[];
}

export interface DomainFeedbackMaterialTransport {
  readonly batch: ContentMaterialBatch;
  readonly coverage: DomainFeedbackMaterialCoverage;
  /** Exact immutable owner frame, not a inferred target/result/gain or another source lookup. */
  readonly readMaterial: (ref: string, start?: number, maximumChars?: number) => ContentMaterialPage;
}

export type DomainFeedbackMaterialRead = { readonly ok: true; readonly value: DomainFeedbackMaterialTransport }
  | { readonly ok: false; readonly reason: string; readonly coverage: DomainFeedbackMaterialCoverage };
