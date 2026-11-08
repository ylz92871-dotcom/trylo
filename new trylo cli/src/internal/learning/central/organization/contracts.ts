/** Public organization knowledge describes how to learn. It is never original
 * business evidence, a quality verdict, a permission or a second funding ledger. */
export interface OrganizationContext {
  readonly purpose: string;
  readonly conditionKeys: readonly string[];
  readonly known: readonly string[];
  readonly residual: readonly string[];
}

export interface OrganizationRecallQuery {
  readonly purpose: string;
  readonly conditionKeys: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly maximumEntries: number;
  readonly maximumCharacters: number;
  /** Stateless navigation position in the current deterministic candidate order. */
  readonly offset?: number;
}

export interface OrganizationKnowledge {
  readonly kind: "knowledge";
  readonly knowledgeId: string;
  readonly supersedes: string | null;
  readonly statement: string;
  readonly conditions: string;
  readonly conditionKeys: readonly string[];
  readonly exceptions: string;
  readonly exceptionKeys: readonly string[];
  readonly implication: string;
  readonly supportFactIds: readonly string[];
  readonly counterexampleFactIds: readonly string[];
  readonly state: "proposed" | "revised" | "withdrawn";
}

export interface OrganizationRecallEvidenceCoverage {
  readonly asOfSequence: number;
  readonly total: number;
  readonly delivered: number;
  readonly unread: number;
  readonly citedSupportCount: number;
  readonly citedCounterexampleCount: number;
  readonly relatedCount: number;
  readonly readRef: string;
  readonly unreadByKind: { readonly progress: number; readonly cost: number; readonly adoption: number; readonly outcome: number; readonly correction: number };
  /** An unread related quality/withdrawal page to inspect, never a counterexample verdict. */
  readonly priorityReadRef: string | null;
  readonly interpretation: "unread_is_unknown_adoption_is_exposure_not_validation";
}

export interface OrganizationKnowledgeBodyRequired {
  readonly factId: string;
  readonly knowledgeId: string;
  readonly readRef: string;
  readonly originalCharacters: number;
  readonly reason: "knowledge_body_required_not_delivered";
}

export interface OrganizationRecallEntry {
  readonly factId: string;
  readonly knowledge: OrganizationKnowledge;
  readonly matchedConditions: readonly string[];
  readonly missingConditions: readonly string[];
  readonly matchedExceptions: readonly string[];
  /** Original effective observations, including contrary and unknown evidence. */
  readonly evidence: readonly OrganizationStored<OrganizationFeedback>[];
  readonly evidenceRevisions: readonly { readonly citedFactId: string; readonly effectiveFactId: string }[];
  /** Required on V2; an unread reference is not a delivered feedback body. */
  readonly evidenceCoverage?: OrganizationRecallEvidenceCoverage;
}

export interface OrganizationRecallPacket {
  readonly schemaVersion: 1 | 2;
  readonly scope: string;
  readonly recallRef: string;
  readonly query: OrganizationRecallQuery;
  readonly entries: readonly OrganizationRecallEntry[];
  readonly materialJson: string;
  readonly interpretation: "organization_hypotheses_not_business_evidence";
  /** Absent on historical packets, whose original retrieval must still replay. */
  readonly navigation?: { readonly remainingEntries: number; readonly nextQuery: OrganizationRecallQuery | null };
  /** Required only on V2. V1 packets retain their exact original shape. */
  readonly evidencePolicy?: "bounded_current_source_heads_v2";
  readonly knowledgeBodyRequired?: readonly OrganizationKnowledgeBodyRequired[];
}

export interface OrganizationExperienceUse {
  readonly packet: OrganizationRecallPacket;
  /** Caller-owned actual central provider delivery receipt, never a prepared request hash. */
  readonly deliveryRef: string;
  readonly changes: readonly {
    readonly knowledgeFactId: string;
    readonly choice: "program" | "investment" | "timing" | "wait" | "unchanged";
    readonly before: string;
    readonly after: string;
    readonly reason: string;
  }[];
}

export interface OrganizationDecision {
  readonly kind: "decision";
  readonly decisionRef: string;
  readonly purposeRef: string;
  readonly context: OrganizationContext;
  readonly program: { readonly programRef: string; readonly depth: string; readonly timing: "now" | "defer" | "wait" | "stop" };
  readonly expectation: { readonly change: string; readonly uncertainties: readonly string[] };
  readonly alternatives: readonly string[];
  readonly issueRefs: readonly string[];
  readonly stageRefs: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly experienceUse: OrganizationExperienceUse | null;
}

export type OrganizationFeedbackResult =
  | { readonly kind: "cost"; readonly usage: { readonly kind: "reported"; readonly tokens: number; readonly calls: number; readonly steps: number }
      | { readonly kind: "unknown"; readonly reason: string } }
  | { readonly kind: "progress"; readonly summary: string; readonly remaining: readonly string[]; readonly resultRefs: readonly string[] }
  | { readonly kind: "adoption"; readonly state: "not_observed" | "used" | "withdrawn"; readonly artifactRefs: readonly string[]; readonly exposureRef: string | null }
  | { readonly kind: "outcome"; readonly state: "pending" | "observed" | "unknown"; readonly summary: string;
      readonly exposureRef: string | null; readonly attribution: "unknown" | "source_reported" }
  | { readonly kind: "correction"; readonly statement: string; readonly conditions: string };

export interface OrganizationFeedback {
  readonly kind: "feedback";
  readonly decisionRef: string;
  /** Stable original source unit; derived summaries reuse that unit, never create extra trials. */
  readonly unitRef: string;
  readonly supersedes: string | null;
  readonly sourceRefs: readonly string[];
  readonly result: OrganizationFeedbackResult;
}

export type OrganizationRecord = OrganizationDecision | OrganizationFeedback | OrganizationKnowledge;

export interface OrganizationStored<T extends OrganizationRecord = OrganizationRecord> {
  readonly factId: string;
  readonly sequence: number;
  readonly value: T;
}

export interface OrganizationProjection {
  readonly scope: string;
  readonly decisions: readonly OrganizationStored<OrganizationDecision>[];
  readonly feedback: readonly OrganizationStored<OrganizationFeedback>[];
  readonly feedbackHistory: readonly OrganizationStored<OrganizationFeedback>[];
  readonly knowledge: readonly OrganizationStored<OrganizationKnowledge>[];
}
