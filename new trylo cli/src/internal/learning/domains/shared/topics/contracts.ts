import type { LearningDomain } from "../../../control/contracts.js";

export const TOPIC_LIMITS = {
  proposalChars: 8192,
  windowChars: 65536,
  evidenceRecords: 32,
  evidenceTextChars: 2048,
  totalEvidenceChars: 32768,
  citations: 8,
  quoteChars: 256,
  alternatives: 4,
  statementChars: 600,
} as const;

export const TOPIC_EVIDENCE_ORIGINS = [
  "user_statement", "execution_result", "checker_result", "model_proposal",
] as const;

export type TopicEvidenceOrigin = (typeof TOPIC_EVIDENCE_ORIGINS)[number];

/** Host-described choice and observation contract, never a measured outcome or a proposed question. */
export type TopicExperimentContext = {
  readonly decision: string;
  readonly observation: string;
};

/** A description of a host-registered observation, never an executable model command. */
export type TopicExperimentDescriptor = {
  readonly ref: string;
  readonly version: string;
  readonly domain: LearningDomain;
  readonly purpose: string;
  /** Host-owned applicability at nomination time; never supplied by the model. */
  readonly conditionHash?: string;
  readonly context?: TopicExperimentContext;
};

/** The trusted host supplies this window after collection/scope gating. Models cannot replace it. */
export type TopicEvidenceWindow = {
  readonly schemaVersion: 1;
  readonly domain: LearningDomain;
  readonly scope: string;
  readonly boardSequence: number;
  readonly watermarks: readonly { readonly runId: string; readonly throughSequence: number }[];
  readonly records: readonly {
    readonly ref: string;
    readonly runId: string;
    readonly sequence: number;
    readonly scope: string;
    readonly origin: TopicEvidenceOrigin;
    readonly text: string;
  }[];
  readonly experiments?: readonly TopicExperimentDescriptor[];
};

export type TopicDraft = {
  readonly schemaVersion: 1;
  readonly question: string;
  readonly whenRelevant: string;
  readonly expectedChange: string;
  readonly citations: readonly { readonly evidenceRef: string; readonly quote: string }[];
  readonly alternatives: readonly { readonly id: string; readonly explanation: string }[];
  readonly discriminator: {
    readonly observation: string;
    readonly hypothesisIds: readonly string[];
  };
};

/** The question can precede an explanation, an answer model and an approved experiment. */
export type TopicQuestionDraft = Pick<TopicDraft, "question" | "whenRelevant" | "expectedChange" | "citations"> & {
  readonly schemaVersion: 2;
};

export type TopicExperimentDraft = Omit<TopicQuestionDraft, "schemaVersion"> & {
  readonly schemaVersion: 3;
  readonly experimentRef: string;
};

/** Model-facing input only. The host selects the canonical grounding version; storage keeps this original object. */
export type TopicGenerationDraft =
  | (Omit<TopicQuestionDraft, "schemaVersion"> & { readonly kind: "topic"; readonly experimentRef?: string })
  | { readonly kind: "no_topic"; readonly reason: string };

export type GroundedTopic = {
  readonly schemaVersion: 1;
  readonly kind: "learning_topic";
  readonly status: "grounded_hypothesis";
  readonly topicId: string;
  readonly domain: LearningDomain;
  readonly scope: string;
  readonly basis: { readonly boardSequence: number; readonly evidenceWindowHash: string };
  readonly question: string;
  readonly whenRelevant: string;
  readonly expectedChange: string;
  readonly alternatives: TopicDraft["alternatives"];
  readonly discriminator: TopicDraft["discriminator"];
  readonly citations: readonly {
    readonly evidenceRef: string;
    readonly runId: string;
    readonly sequence: number;
    readonly origin: TopicEvidenceOrigin;
    readonly start: number;
    readonly end: number;
    readonly sourceHash: string;
    readonly quoteHash: string;
  }[];
};

export type GroundedQuestion = Omit<GroundedTopic, "schemaVersion" | "status" | "alternatives" | "discriminator"> & {
  readonly schemaVersion: 2;
  readonly status: "grounded_question";
};

export type GroundedExperimentQuestion = Omit<GroundedQuestion, "schemaVersion"> & {
  readonly schemaVersion: 3;
  readonly experiment: { readonly ref: string; readonly version: string; readonly conditionHash?: string };
};

/** One topic concept with versioned stages; v1 remains the full hypothesis representation. */
export type GroundedLearningTopic = GroundedTopic | GroundedQuestion | GroundedExperimentQuestion;

export type TopicFailureReason =
  | "topic_input_size" | "topic_json_invalid" | "topic_shape_invalid"
  | "topic_window_invalid" | "topic_evidence_missing" | "topic_quote_missing"
  | "topic_quote_ambiguous" | "topic_citation_duplicate" | "topic_self_support_only" | "topic_experiment_missing";

export type TopicResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: TopicFailureReason };
