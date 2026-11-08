import type { BoardState } from "../../../learning/control/state.js";
import type { SessionRecord } from "../../../ports/session.js";
import type { FeedbackSourceBinding } from "../../reward/explanation-source.js";
import type { ContentArtifactMapping } from "./artifact.js";

/** A read projection of an existing receipt. Adoption, display, execution and quality retain separate meanings. */
export interface ContentAdoption {
  readonly ref: string;
  readonly artifact: ContentArtifactMapping;
  readonly basis: "reward_target" | "method_fielding" | "tool_use" | "workflow_session_adoption" | "content_context_delivery";
  readonly exposure: "displayed" | "executed" | "adopted" | "requested";
  readonly receiptId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly attemptId?: string;
  /** Present only for an exact tool source binding, never synthesized for a method display. */
  readonly toolUnitId?: string;
  readonly sourceSequence?: number;
  readonly boardUseSequence?: number;
  readonly sourceRefs: readonly string[];
  readonly details: string;
}

export interface ContentAdoptionGap {
  readonly receiptId: string;
  readonly reason: "session_address_missing" | "ambiguous_tool_address" | "workflow_metadata_invalid" | "content_delivery_metadata_invalid";
  readonly sourceRefs: readonly string[];
}

export interface ContentAdoptionInput {
  readonly board: BoardState;
  readonly scope: string;
  readonly sessionId: string;
  /** Canonical readFeedbackExplanation already validated this exact fixed journal snapshot. */
  readonly records: readonly SessionRecord[];
  readonly bindings: readonly FeedbackSourceBinding[];
  readonly artifacts: readonly ContentArtifactMapping[];
}

export interface ContentAdoptionProjection {
  readonly adoptions: readonly ContentAdoption[];
  readonly gaps: readonly ContentAdoptionGap[];
}
