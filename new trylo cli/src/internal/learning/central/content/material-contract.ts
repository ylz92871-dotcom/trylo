import type { LearningIssue } from "../../control/coordination-contract.js";
import type { LearningDomain } from "../../control/contracts.js";
import type { TopicEvidenceWindow } from "../../domains/shared/topics/contracts.js";

/** Original source coordinates and text. This larger content view is not a WS1 window. */
export type ContentEvidenceRecord = TopicEvidenceWindow["records"][number];

export type ContentSubsystem = "method" | "tool" | "workflow" | "skill" | "collaboration";

export interface ContentArtifactRef { readonly id: string; readonly version: string }

/** Source-address mapping only. It neither merges questions nor certifies source completeness. */
export interface ContentSourceAlias { readonly ref: string; readonly recordRefs: readonly string[] }

export interface ContentLinks {
  readonly issueIds: readonly string[];
  readonly topicIds: readonly string[];
  readonly artifactRefs: readonly ContentArtifactRef[];
}

export interface ContentRequirement {
  readonly id: string;
  readonly requirement: string;
  readonly conditions: readonly string[];
  readonly answerRequirement: string;
  readonly sourceRefs: readonly string[];
}

/** Availability is a source claim. The semantic process must apply support and conditions. */
export interface ContentKnownAnswer {
  readonly answerId: string;
  readonly question: string;
  readonly requirement: string;
  readonly answer: string;
  readonly conditions: readonly string[];
  readonly supportRefs: readonly string[];
  readonly artifactRefs: readonly ContentArtifactRef[];
}

export interface ContentMaterial {
  readonly id: string;
  readonly kind: "requirement" | "experience" | "known_answer" | "context" | "feedback";
  readonly subsystem: ContentSubsystem;
  readonly context: string;
  readonly recordRefs: readonly string[];
  readonly requirementIds: readonly string[];
  readonly answerIds: readonly string[];
  readonly links: ContentLinks;
}

export interface ContentMaterialBatch {
  readonly records: readonly ContentEvidenceRecord[];
  readonly requirements: readonly ContentRequirement[];
  readonly answers: readonly ContentKnownAnswer[];
  readonly materials: readonly ContentMaterial[];
  /** Absent on historical packets; retain absence to preserve their exact payload/hash. */
  readonly aliases?: readonly ContentSourceAlias[];
}

export interface ContentPacketInput extends ContentMaterialBatch {
  readonly scope: string;
  readonly domain: LearningDomain;
  readonly boardSequence: number;
  /** Canonical report and PA decision remain intact; they are not source measurements. */
  readonly focus?: LearningIssue;
  readonly requestedRefs?: readonly string[];
}

export interface ContentPacket extends ContentMaterialBatch {
  readonly schemaVersion: 1;
  readonly packetId: string;
  readonly scope: string;
  readonly domain: LearningDomain;
  readonly boardSequence: number;
  readonly focus?: LearningIssue;
  readonly retrieval: {
    readonly coverage: "bounded";
    readonly requestedRefs: readonly string[];
    readonly missingRefs: readonly string[];
  };
}

export const CONTENT_MATERIAL_FAILURES = ["content_material_invalid", "content_material_conflict", "content_material_scope",
  "content_material_capacity", "content_material_unavailable", "content_material_cancelled"] as const;

export type ContentMaterialFailure = (typeof CONTENT_MATERIAL_FAILURES)[number];

export type ContentMaterialResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ContentMaterialFailure };

export interface ContentRetrievalQuery {
  readonly scope: string;
  readonly domain: LearningDomain;
  readonly boardSequence: number;
  readonly issueIds: readonly string[];
  readonly topicIds: readonly string[];
  readonly artifactRefs: readonly ContentArtifactRef[];
  readonly sourceRefs: readonly string[];
}

/** Source adapters retain ownership of their records. This port starts no model or tool execution. */
export interface ContentMaterialSource {
  retrieve(query: ContentRetrievalQuery, signal: AbortSignal): Promise<ContentMaterialResult<ContentMaterialBatch>>;
}

export const CONTENT_MATERIAL_LIMITS = Object.freeze({
  packetChars: 65536, recordChars: 32768, statementChars: 8192,
  records: 64, materials: 64, requirements: 32, answers: 32, refs: 256,
});
