export const CENTRAL_ADVISORY_ALGORITHM = "central-knowledge-advisory-v1";
export const CENTRAL_ADVISORY_TYPE = "central_knowledge_advisory";
export const CENTRAL_ADVISORY_ID_PREFIX = "central-advisory:";
export const CENTRAL_ADVISORY_PUBLICATION_PREFIX = "central-advisory-publication:";

export interface CentralAdvisoryKnowledge {
  readonly statement: string;
  readonly conditions: string;
  readonly sourceRefs: readonly string[];
}

interface CentralAdvisoryDecision {
  readonly schemaVersion: 1;
  readonly type: typeof CENTRAL_ADVISORY_TYPE;
  readonly scope: string;
  readonly budgetId: string;
  readonly advisoryId: string;
  readonly decisionRef: string;
  readonly deliveryRef: string;
  readonly appliedStateRef: string;
  readonly appliedSequence: number;
  readonly previousPublicationRef: string | null;
}

/** An explicit public source selection, never an activation or quality verdict. */
export interface CentralAdvisoryPublish extends CentralAdvisoryDecision, CentralAdvisoryKnowledge {
  readonly kind: "publish";
  readonly intentId: string;
  readonly purposeHeadRef: string;
  readonly purposeConditions: readonly string[];
  readonly knowledgeHash: string;
  readonly whenRelevant: string;
  readonly uncertainty: string;
  /** Source-owner access ancestry is carried, not interpreted by this pure reader. */
  readonly accessSourceRefs: readonly string[];
}

/** Withdraws one actual public version without editing the internal knowledge. */
export interface CentralAdvisoryWithdraw extends CentralAdvisoryDecision {
  readonly kind: "withdraw";
  readonly publicationRef: string;
  readonly why: string;
}

export type CentralAdvisoryValue = CentralAdvisoryPublish | CentralAdvisoryWithdraw;

export interface CentralAdvisoryRecord {
  readonly ref: string;
  /** The immutable actual Board fact reference, including its payload hash. */
  readonly version: string;
  readonly sequence: number;
  readonly value: CentralAdvisoryValue;
}

export type CentralAdvisoryStatus = "current" | "source_changed" | "purpose_withdrawn"
  | "publication_withdrawn" | "superseded";

export interface CentralAdvisoryPublicationView extends CentralAdvisoryKnowledge {
  readonly id: string;
  readonly version: string;
  readonly purposeHeadRef: string;
  readonly purposeConditions: readonly string[];
  readonly intentId: string;
  readonly knowledgeHash: string;
  readonly whenRelevant: string;
  readonly uncertainty: string;
  readonly accessSourceRefs: readonly string[];
  readonly status: CentralAdvisoryStatus;
  readonly sequence: number;
  readonly decisionRef: string;
  readonly deliveryRef: string;
}
