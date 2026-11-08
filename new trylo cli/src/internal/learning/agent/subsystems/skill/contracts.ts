import type { JsonObject, JsonValue } from "../../../../protocol/envelope.js";

/** A transport role never establishes confirmed human authorship or permission. */
export type SkillUserAttribution = "unverified" | "not_recorded" | "unknown";

export type SkillSourceContext = {
  readonly currentUserAttribution: SkillUserAttribution;
  readonly unverifiedUserSequences?: readonly number[];
  readonly unknownUserSequences?: readonly number[];
  readonly omittedUserSourceEntries?: number;
  /** May be omitted before the current attribution under a small transport budget. */
  readonly interpretation?: string;
};

export type HermesSkillAllowance = {
  readonly maxCalls: number;
  readonly maxOutputTokens: number;
};

/** The control centre allocates work; the runtime supplies its context. */
export type HermesSkillGrant = {
  readonly subsystem: "skill";
  readonly allowance: HermesSkillAllowance;
};

/** Native context is optional so an explicit learn request needs no invented task family. */
export type HermesSkillOpportunity = {
  readonly trigger: "implicit" | "explicit";
  readonly workspaceRoot?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly mode?: "agent" | "office";
  readonly taskGoal?: string;
  readonly resultSummary?: string;
  readonly events?: readonly JsonObject[];
  readonly fileHints?: JsonValue;
  readonly verification?: JsonValue;
  readonly learnRequest?: JsonValue;
  readonly flags?: JsonObject;
  readonly config?: JsonObject;
  /** Bounded visible execution history, not hidden reasoning or model instructions. */
  readonly experience?: JsonObject;
};

export type HermesSkillUsage = {
  readonly calls: number;
  readonly usageStatus: "reported" | "missing";
  readonly outputTokens?: number;
  readonly totalTokens?: number;
};

/** Completion describes the native invocation, never verification or promotion of a skill. */
export type HermesSkillRunResult = {
  readonly status: "completed" | "waiting" | "disabled" | "cancelled" | "failed";
  readonly usage: HermesSkillUsage;
  /** Preserve the original body, including pendingId/reasonCode, without a new envelope. */
  readonly legacyReply: unknown;
  readonly error?: never;
} | {
  readonly status: "cancelled" | "failed";
  readonly usage: HermesSkillUsage;
  /** A transport failure has no native body to invent. */
  readonly error: { readonly code: string };
  readonly legacyReply?: never;
};

export type HermesSkillEntryStop =
  | { readonly status: "disabled"; readonly reason: "collection_disabled" }
  | { readonly status: "cancelled"; readonly reason: "cancelled" }
  | { readonly status: "waiting"; readonly reason: "allowance_exhausted" | "no_opportunity" }
  | { readonly status: "failed"; readonly reason: "invalid_grant" };

/** An entry fence has no native reply to fabricate or return through compatibility APIs. */
export type HermesSkillNotRun = HermesSkillEntryStop & {
  readonly usage: HermesSkillUsage;
  readonly legacyReply?: never;
};

export type HermesSkillLearningResult = HermesSkillRunResult | HermesSkillNotRun;

export type HermesSkillHost = {
  readonly collection: () => "enabled" | "disabled";
  readonly opportunity: (signal: AbortSignal) => Promise<HermesSkillOpportunity | undefined>;
  readonly run: (opportunity: HermesSkillOpportunity, allowance: HermesSkillAllowance, signal: AbortSignal) => Promise<HermesSkillRunResult>;
};
