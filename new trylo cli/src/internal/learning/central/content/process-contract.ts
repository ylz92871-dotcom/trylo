import type { TopicQuestionDraft } from "../../domains/shared/topics/contracts.js";

export type ContentCitation = TopicQuestionDraft["citations"][number];

/** Public, inspectable results, not hidden model reasoning or a host truth certificate. */
export interface ContentKnowledge {
  readonly id: string;
  readonly statement: string;
  readonly conditions: string;
  readonly citations: readonly ContentCitation[];
}

export interface ContentApplication {
  readonly id: string;
  readonly requirementRefs: readonly string[];
  readonly answerRefs: readonly string[];
  readonly binding: string;
  readonly result: string;
  readonly conditions: string;
  readonly citations: readonly ContentCitation[];
}

export interface ContentRelation extends Omit<TopicQuestionDraft, "schemaVersion"> { readonly id: string }

export interface ContentPreparation {
  readonly description: string;
  readonly sourceRefs: readonly string[];
}

export interface KnownApplicationDraft {
  readonly schemaVersion: 1;
  readonly knowledge: readonly ContentKnowledge[];
  readonly applications: readonly ContentApplication[];
  readonly relations: readonly ContentRelation[];
  readonly preparations: readonly ContentPreparation[];
}

export interface RelationAssessment {
  readonly relationId: string;
  readonly disposition: "answered" | "residual" | "unsupported";
  readonly applicationIds: readonly string[];
  readonly reason: string;
}

export interface ContentComparison {
  readonly relationId: string;
  readonly priorRef: string;
  readonly kind: "same_question" | "covered" | "changed_conditions" | "different_target" | "undetermined";
  readonly reason: string;
  readonly citations: readonly ContentCitation[];
}

export interface ResidualReviewDraft {
  readonly schemaVersion: 1;
  readonly assessments: readonly RelationAssessment[];
  readonly comparisons: readonly ContentComparison[];
  readonly selectedRelationId: string | null;
  /** A proposal to the existing PA/issue owner. Never a Board decision or grant. */
  readonly recommendation: {
    readonly kind: "continue" | "revise" | "end" | "undetermined";
    readonly reason: string;
    readonly citations: readonly ContentCitation[];
  };
}

export type ContentProcessFailure = "content_json_invalid" | "content_shape_invalid" | "content_reference_invalid"
  | "content_quote_invalid" | "content_review_incomplete" | "content_selection_invalid" | "content_capacity"
  | "content_cancelled" | "content_model_failed" | "content_packet_invalid";

export type ContentResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ContentProcessFailure };

export interface ContentSemanticRequest {
  readonly stage: "apply_known" | "residual_review";
  readonly inputHash: string;
  readonly instruction: string;
  readonly materialJson: string;
}

/** The caller owns provider selection, paid-call authorization and reservation/settlement. No loop. */
export interface ContentSemanticPort {
  generate(request: ContentSemanticRequest, signal: AbortSignal): Promise<string>;
}
