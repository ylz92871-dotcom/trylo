import type { CentralResponseCost, CentralResponseHistory, CentralResponseTarget } from "../../learning/control/decision/prediction-input.js";
import type { CentralStageCostInput } from "../../learning/control/decision/prediction-cost.js";
import type { EmpiricalTopicPolicy, TopicPairedMeasurement } from "../../learning/domains/shared/topics/empirical-model.js";
import type { BoardState } from "../../learning/control/state.js";
import type { CentralResponseWindow } from "../learning-allocation/response-source.js";

/** Source-owned lineage, not another window registration or a causal certificate. */
export type ContentLearningSourceChain = {
  readonly kind: "traced";
  readonly issueId: string;
  readonly grantId: string;
  readonly result: { readonly ref: string; readonly artifactRef: string; readonly version: string };
  readonly adoption: { readonly ref: string; readonly artifactRef: string; readonly version: string;
    readonly unitId: string; readonly windowRef: string };
  readonly registration: { readonly ref: string; readonly unitId: string; readonly windowRef: string };
  readonly sourceRefs: readonly string[];
} | { readonly kind: "unknown"; readonly issueId: string; readonly reason: string; readonly sourceRefs: readonly string[] };

export type ContentHistorySourceBinding = {
  readonly window: CentralResponseWindow;
  readonly chain: ContentLearningSourceChain;
  /** A stage's original closed reservation set. Missing/unfinished tails remain unknown. */
  readonly usage: Omit<CentralStageCostInput, "grant"> | null;
};

export type ContentLearningHistoryInput = {
  readonly board: BoardState;
  readonly target: CentralResponseTarget;
  readonly measurementPolicy: EmpiricalTopicPolicy;
  readonly sources: readonly ContentHistorySourceBinding[];
};

export type ContentHistoryEvidence = {
  readonly unitId: string;
  readonly opportunityId: string;
  readonly grantId: string;
  readonly chain: ContentLearningSourceChain;
  readonly sourceWindow: CentralResponseWindow;
  readonly projectedWindow: CentralResponseWindow;
  readonly reservationIds: readonly string[];
  readonly measurementIds: readonly string[];
};

export type ContentLearningHistoryProjection = {
  readonly status: "ready";
  readonly schemaVersion: 1;
  readonly boardSequence: number;
  readonly sourceRef: string;
  readonly history: readonly CentralResponseHistory[];
  readonly costs: readonly { readonly unitId: string; readonly cost: CentralResponseCost }[];
  /** Original records retain their per-comparison meaning and complete revision lineage. */
  readonly pairedRecords: readonly TopicPairedMeasurement[];
  readonly evidence: readonly ContentHistoryEvidence[];
} | { readonly status: "invalid"; readonly reason: string };
