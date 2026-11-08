/** Attribution only. Expert identity/configuration authority remains with the expert library. */
export const EXPERIENCE_OWNER_LIMITS = { experienceKey: 512, workspace: 512, profileId: 200, memberId: 200 } as const;
export const EXPERIENCE_FEEDBACK_LIMITS = { referenceMaxChars: 512, summaryMaxChars: 1500, maxVersionIds: 32, maxSourceRefs: 32 } as const;
export const EXPERIENCE_FEEDBACK_OUTCOMES = ["helped", "not_helped", "uncertain"] as const;
export const EXPERIENCE_ASSESSMENT_DIAGNOSES = ["practice_defect", "context_mismatch", "supported", "uncertain"] as const;
export const EXPERIENCE_OBSERVATION_RESULTS = ["observed", "contradicted", "unknown"] as const;

/** A PA explanation, not an external verifier verdict or an automatic rule change. */
export type ExperienceAssessment = {
  readonly versionId: string;
  readonly diagnosis: (typeof EXPERIENCE_ASSESSMENT_DIAGNOSES)[number];
  readonly observations: readonly {
    readonly expectationId: string;
    readonly result: (typeof EXPERIENCE_OBSERVATION_RESULTS)[number];
    readonly sourceRefs: readonly string[];
  }[];
};

export type ExperienceOwner = { readonly kind: "expert"; readonly experienceKey: string }
  | { readonly kind: "personal_agent"; readonly experienceKey: string }
  | { readonly kind: "legacy_member"; readonly workspace: string; readonly profileId: string; readonly memberId: string };

/** Loading or dispatching a configuration proves exposure, never behavioral success or quality. */
export type ExperienceBoundaryReceipt = {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly phase: "loaded" | "dispatched";
  readonly scope: string;
  readonly owner: ExperienceOwner;
  readonly ownerFingerprint: string;
  readonly versionIds: readonly string[];
  readonly boundary: {
    readonly executionId: string;
    readonly taskId: string;
    readonly round: number;
    readonly role: string;
    readonly memberId?: string;
    readonly teamRunId?: string;
    readonly configurationRef?: string;
    readonly requestId?: string;
  };
  readonly recordedAt: string;
};

/** PA's attributed use feedback is a claim backed by references, not an independent quality verdict. */
export type ExperienceUseFeedback = {
  readonly assessments?: readonly ExperienceAssessment[];
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly phase: "use_feedback";
  readonly scope: string;
  readonly owner: ExperienceOwner;
  readonly versionIds: readonly string[];
  readonly usageReceiptId: string;
  readonly summary: string;
  readonly sourceRefs: readonly string[];
  readonly outcome: (typeof EXPERIENCE_FEEDBACK_OUTCOMES)[number];
  readonly recordedAt: string;
};
