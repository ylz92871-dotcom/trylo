import type { RewardSource } from "../../reward/contracts.js";
import type { FeedbackInvestigationQuestion, LegacyFeedbackUnitExplanation, LegacyRevisionPrefixComparison,
  RewardExposureBinding } from "../../reward/explanation/explanation-policy.js";
import type { ReportedFeedbackEstimate, ReportedFeedbackUnit } from "../../reward/explanation/reported-estimate.js";

/** Existing issue/topic identities are references. This projection owns no issue or asset lifecycle. */
export interface FeedbackContentLink {
  readonly issueId: string;
  readonly scope: string;
  readonly domain: string;
  readonly topicId?: string;
  readonly artifactRefs: readonly { readonly ref: string; readonly version: string }[];
  readonly requirementRefs: readonly string[];
  readonly unitId: string;
  readonly exposureId?: string;
  readonly source: RewardSource;
}

interface ObservationIdentity {
  readonly id: string;
  readonly issueId: string;
  readonly unitId: string;
  /** Original use address, distinct from the later observation's own address. */
  readonly source: RewardSource;
  readonly observationSource: RewardSource;
  readonly evidenceRefs: readonly string[];
  /** Recorded observation time; never substituted for the source observer's original known-at. */
  readonly observedAt: number;
  readonly supersedes?: string;
}

export type ContentFeedbackObservation = ObservationIdentity & (
  | { readonly kind: "task_result"; readonly requirementRef: string; readonly measurementRef: string;
    readonly result: "success" | "failure" | "partial" | "unknown" }
  | { readonly kind: "cost"; readonly quantity: number; readonly unit: string; readonly metricRef: string;
    readonly measurementRef: string }
  | { readonly kind: "user_correction"; readonly text: string; readonly targetRef: string;
    readonly targetRole: "same_requirement" | "new_requirement" | "unspecified" }
  | { readonly kind: "learning_gain"; readonly value: number; readonly metricRef: string;
    readonly comparison: { readonly baselineRef: string; readonly treatmentRef: string; readonly requirementRef: string;
      readonly windowRef: string; readonly conditionRef: string; readonly protocolRef: string;
      readonly measurementRefs: readonly [string, string] } }
);

/** Narrow domain input: the existing readFeedbackExplanation result is structurally assignable.
 * Source parsing, Board admission and statistical estimation stay with their existing owners.
 */
export type ContentFeedbackExplanation = {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly source: { readonly sessionId: string; readonly cohortThrough: number; readonly observedThrough: number;
    readonly basisHash: string; readonly decoder: string };
  readonly bindings: readonly RewardExposureBinding[];
  readonly reported: ReportedFeedbackEstimate;
  readonly questions: readonly FeedbackInvestigationQuestion[];
  readonly legacy: { readonly status: "available"; readonly revision: number;
    readonly units: readonly LegacyFeedbackUnitExplanation[] } | { readonly status: "unavailable"; readonly reason: string };
  readonly legacyRevision: { readonly status: "available"; readonly value: LegacyRevisionPrefixComparison }
    | { readonly status: "unavailable"; readonly reason: string };
} | { readonly schemaVersion: 1; readonly ok: false; readonly reason: string; readonly atSequence?: number };

export interface ContentFeedbackInput {
  readonly explanation: ContentFeedbackExplanation;
  readonly links: readonly FeedbackContentLink[];
  readonly observations?: readonly ContentFeedbackObservation[];
}

export interface ContentFeedbackObservationEntry {
  readonly state: "active" | "superseded";
  readonly observation: ContentFeedbackObservation;
}

export interface ContentFeedbackRow {
  readonly link: FeedbackContentLink;
  readonly association: { readonly status: "linked"; readonly registeredAt: number }
    | { readonly status: "unlinked"; readonly reason: "source_unavailable" | "unit_missing" | "source_mismatch" | "exposure_mismatch" };
  readonly report: { readonly status: "available"; readonly unit: ReportedFeedbackUnit; readonly closeEventId?: string }
    | { readonly status: "unknown"; readonly reason: string };
  readonly legacy: LegacyFeedbackUnitExplanation | { readonly unitId: string; readonly status: "unavailable"; readonly reason: string };
  readonly revision: LegacyRevisionPrefixComparison;
  readonly observations: readonly ContentFeedbackObservationEntry[];
  readonly taskResult: { readonly status: "observed"; readonly observationIds: readonly string[] }
    | { readonly status: "unknown"; readonly reason: "no_task_measurement" | "task_measurement_unknown" | "requirement_not_bound" | "unlinked_use" };
  readonly cost: { readonly status: "observed"; readonly observationIds: readonly string[] }
    | { readonly status: "unknown"; readonly reason: "no_cost_measurement" | "unlinked_use" };
  /** Submitted gain values remain claims. Only the owning comparison protocol can qualify learning gain. */
  readonly learningGain: { readonly status: "unknown"; readonly reason: "no_identified_learning_gain";
    readonly claimObservationIds: readonly string[] };
  readonly questions: readonly FeedbackInvestigationQuestion[];
}

export interface ContentFeedbackMaterial {
  readonly ref: string;
  readonly text: string;
  readonly sourceRefs: readonly string[];
  readonly issueId: string;
  readonly domain: string;
}

export interface ContentFeedbackProjection {
  readonly schemaVersion: 1;
  readonly status: "available" | "source_unavailable";
  readonly sourcePosition: { readonly sessionId: string; readonly cohortThrough: number; readonly observedThrough: number;
    readonly basisHash: string; readonly decoder: string } | null;
  readonly boardPosition: { readonly status: "available"; readonly revision: number }
    | { readonly status: "unavailable"; readonly reason: string };
  /** Full source cohort, never recomputed on the linked rows. */
  readonly reported: ReportedFeedbackEstimate | null;
  readonly rows: readonly ContentFeedbackRow[];
  readonly unlinkedObservations: readonly ContentFeedbackObservation[];
  readonly materialRecords: readonly ContentFeedbackMaterial[];
  readonly interpretation: "reports_task_results_costs_and_gain_claims_are_distinct";
}
