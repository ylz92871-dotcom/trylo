import type { CentralLearningAgentDomain, CentralLearningAllowance } from "../../control/coordination-contract.js";
import type { JsonObject } from "../../../protocol/envelope.js";
import type { CentralLearningBudgetRootRef } from "../../control/central-budget-contract.js";
import type { CentralLearningResources } from "../../control/central-budget-contract.js";
import type { OrganizationKnowledge } from "../organization/contracts.js";
import type { CentralGenerationLimits } from "./generation.js";
import type { VerifiedProviderPositiveNote } from "./provider-positive.js";

/** References the existing domain owner. User questions never become Agent issues. */
export type CentralLearningSubject =
  | { readonly plane: "agent"; readonly domain: CentralLearningAgentDomain; readonly issueId: string }
  | { readonly plane: "user"; readonly ledgerRef: string; readonly questionRef: string }
  /** A grounded learning purpose may precede any domain's native work entry. */
  | { readonly plane: "central"; readonly questionRef: string };

export interface CentralRuntimeMaterial {
  readonly ref: string;
  readonly kind: "source" | "knowledge" | "feedback" | "organization" | "numerical_advice" | "work_result";
  readonly text: string;
  readonly sourceRefs: readonly string[];
}

export interface CentralLearningOpportunity {
  readonly subject: CentralLearningSubject;
  readonly sourceRef: string;
  readonly description: string;
  readonly constraints: readonly string[];
}

interface OperationPurpose {
  readonly operationId: string;
  readonly purpose: string;
  readonly expectedChange: string;
  readonly sourceRefs: readonly string[];
}

export type CentralLearningOperation = OperationPurpose & (
  | { readonly kind: "think"; readonly maxOutputTokens?: number }
  | { readonly kind: "read"; readonly refs: readonly string[]; readonly maximumChars: number }
  | { readonly kind: "consult"; readonly allowance: CentralLearningAllowance }
  | { readonly kind: "dispatch"; readonly allowance: CentralLearningAllowance;
      readonly destination?: { readonly plane: "agent"; readonly domain: CentralLearningAgentDomain } | { readonly plane: "user" } }
);

/** A bounded agenda inspection may precede any grounded learning intent. */
export type CentralAgendaRead = Extract<CentralLearningOperation, { kind: "read" }>;

export type CentralLearningWait =
  | { readonly kind: "facts"; readonly sourceRefs: readonly string[]; readonly reason: string }
  | { readonly kind: "use_feedback"; readonly sourceRefs: readonly string[]; readonly reason: string }
  | { readonly kind: "resources"; readonly sourceRefs: readonly string[]; readonly reason: string }
  | { readonly kind: "until"; readonly at: number; readonly sourceRefs: readonly string[]; readonly reason: string };

export interface CentralLearningIntentDraft {
  readonly intentId: string;
  readonly subject: CentralLearningSubject;
  readonly goal: string;
  readonly rationale: string;
  readonly conditions: readonly string[];
  readonly knowledge: readonly { readonly statement: string; readonly conditions: string; readonly sourceRefs: readonly string[] }[];
  readonly residual: readonly string[];
  readonly commitment: { readonly purpose: string; readonly assumptions: readonly string[]; readonly reconsiderWhen: readonly string[] };
  readonly revisionReason: string;
  readonly sourceRefs: readonly string[];
  readonly derivation?: { readonly relation: string; readonly whenRelevant: string; readonly parentRefs: readonly string[];
    readonly citations: readonly { readonly evidenceRef: string; readonly quote: string }[] };
  /** Open retains the purpose without a successor commitment. Ending expenditure
   * and answering the original goal are independent facts. */
  readonly continuation:
    | { readonly kind: "open" }
    | { readonly kind: "ready"; readonly operation: CentralLearningOperation }
    | { readonly kind: "waiting"; readonly wait: CentralLearningWait }
    | { readonly kind: "ended"; readonly goalState: "open" | "answered" | "withdrawn"; readonly reason: string };
}

export interface CentralCompletedOperation {
  readonly intentId: string;
  readonly operation: CentralLearningOperation;
  readonly outcome: "returned" | "failed" | "unknown";
  readonly resultRefs: readonly string[];
  readonly publicResult: string;
  readonly wait?: CentralLearningWait;
}

export interface CentralRuntimeWork {
  readonly intentId: string;
  readonly operation: Extract<CentralLearningOperation, { kind: "dispatch" }>;
  readonly workRef: string;
  /** Domain-owned recovery frame, never a second grant or permission. */
  readonly frame: JsonObject;
}

export interface CentralLearningRuntimeState {
  readonly schemaVersion: 1;
  readonly scope: string;
  readonly intents: readonly CentralLearningIntentDraft[];
  /** The original pending inspection; only its execution/refusal clears it. */
  readonly agendaRead?: CentralAgendaRead;
  readonly completed: readonly CentralCompletedOperation[];
  readonly running: readonly CentralRuntimeWork[];
  readonly materials: readonly CentralRuntimeMaterial[];
  readonly consumedSourceRefs: readonly string[];
}

export interface CentralLearningConfiguration {
  readonly schemaVersion: 1;
  readonly configurationRef: string;
  readonly authorizationRef: string;
  /** Actual resolved provider connection identity, separate from reasoning and operation limits. */
  readonly providerConnectionRef?: string;
  /** Configured model/reasoning and default generation baseline; absent on
   * legacy records. A single thought's actual cap stays in its operation and
   * receipt and does not itself change this failure-recovery condition. */
  readonly generationRef?: string;
  /** Advertised single-computation generation capability, never additional root authority. */
  readonly generationLimits?: CentralGenerationLimits;
  /** One central thought's total-token ceiling; absent legacy configs retain allowance.maxTokens. */
  readonly thoughtMaxTokens?: number;
  readonly allowance: CentralLearningAllowance;
  readonly rootRef?: CentralLearningBudgetRootRef;
}

export interface CentralLearningWake { readonly reason: string; readonly sourceRefs: readonly string[] }

export interface CentralDeliberationRequest {
  readonly schemaVersion: 1;
  /** Wire presentation only. Canonical agenda, read progress and funding stay with their original owners. */
  readonly activePurposeDelivery?: {
    readonly version: "active-purpose-navigation-v1" | "active-purpose-navigation-v2";
    readonly agendaVersion: string;
    readonly maximumEntries: number;
  };
  readonly scope: string;
  readonly budgetId: string;
  readonly configuration: CentralLearningConfiguration;
  readonly boardSequence: number;
  readonly resources: {
    readonly boardSequence: number; readonly budgetId: string;
    readonly limits: CentralLearningResources; readonly occupied: CentralLearningResources; readonly available: CentralLearningResources;
    readonly status: "available" | "exhausted" | "held"; readonly holdReason: string | null;
  };
  readonly stateRef: string;
  readonly state: CentralLearningRuntimeState;
  readonly opportunities: readonly CentralLearningOpportunity[];
  readonly materials: readonly CentralRuntimeMaterial[];
  readonly organization: readonly CentralRuntimeMaterial[];
  readonly operation: CentralLearningOperation;
}

/** Explicit public-reference choices, resolved by the host from the delivered
 * input/result. They neither activate an asset nor grant source access. */
export type CentralKnowledgeHandoffDecision =
  | { readonly kind: "publish"; readonly intentId: string; readonly knowledgeHash: string;
      readonly whenRelevant: string; readonly uncertainty: string }
  | { readonly kind: "withdraw"; readonly publicationRef: string; readonly why: string };

export interface CentralDeliberationOutput {
  readonly schemaVersion: 1;
  /** Complete current agenda. Existing intents may only change with an explicit reason. */
  readonly intents: readonly CentralLearningIntentDraft[];
  /** Omission preserves an existing pending inspection; this never grants domain execution. */
  readonly agendaRead?: CentralAgendaRead;
  readonly publicExplanation: string;
  readonly sourceRefs: readonly string[];
  readonly alternatives?: readonly string[];
  readonly organizationUse?: { readonly recallRef: string; readonly changes: readonly {
    readonly knowledgeFactId: string; readonly choice: "program" | "investment" | "timing" | "wait" | "unchanged";
    readonly before: string; readonly after: string; readonly reason: string }[] };
  readonly organizationKnowledge?: readonly OrganizationKnowledge[];
  /** Absent on historical receipts; never manufacture an empty legacy field. */
  readonly knowledgeHandoffs?: readonly CentralKnowledgeHandoffDecision[];
}

/** Adapter owns real provider reservation/settlement at the original root. */
export interface CentralDeliberationDeliveryConstraints {
  /** Pure host-authenticated judgment context, applied at every quote and to
   * the final delivered request. It creates no source or execution authority. */
  readonly projectJudgmentContext?: (candidate: CentralDeliberationRequest) => CentralDeliberationRequest;
  /** Pure host capacity, never serialized into the model request. Packing may
   * build an incomplete view; admission must retain its required source facts.
   * Omission preserves the strict final check for existing callers. */
  readonly sourceProgressFits: (candidate: CentralDeliberationRequest, phase?: "packing" | "admission") => boolean;
}

export interface CentralDeliberationPort {
  /** Pure resource quote for a fresh host-created automatic thought. Undefined
   * preserves the advertised default. The driver records any selection in the
   * original operation before issuing; model choices and recovery are excluded. */
  selectAutomaticOutput?(request: CentralDeliberationRequest, signal: AbortSignal,
    constraints?: CentralDeliberationDeliveryConstraints): Promise<number | undefined>;
  /** Pure delivery projection and capacity check. No reservation or source
   * consumption occurs; returned materials are the exact visible context. */
  prepareDelivery?(request: CentralDeliberationRequest, signal: AbortSignal,
    constraints?: CentralDeliberationDeliveryConstraints): Promise<CentralDeliberationRequest>;
  deliberate(request: CentralDeliberationRequest, signal: AbortSignal,
    constraints?: CentralDeliberationDeliveryConstraints): Promise<CentralDeliberationOutput>;
  inspect?(input: { readonly scope: string; readonly budgetId: string; readonly operationId: string }, signal: AbortSignal): Promise<
    { readonly status: "not_sent" | "unknown"; readonly sourceRefs: readonly string[];
      /** Optional, non-wire proof from the original funding capability. A bare
       * not_sent result never authorizes admission after an uncertain write. */
      readonly admission?: { readonly scope: string; readonly operationId: string; readonly reservationId: string;
        readonly rootRef: CentralLearningBudgetRootRef; readonly ownerId: string; readonly boardSequence: number } }
    | { readonly status: "returned"; readonly request: CentralDeliberationRequest; readonly output: CentralDeliberationOutput;
      readonly deliveryRef: string; readonly sourceRefs: readonly string[];
      /** Original public delivery evidence. Integration must validate it before
       * deriving authority; its presence alone supplies none. */
      readonly wireEvidence?: unknown }>;
}

export interface CentralRuntimeSnapshot {
  readonly boardSequence: number;
  /** Verified original normal-turn producer metadata; never learning material or a business notice. */
  readonly providerPositiveNotes?: readonly VerifiedProviderPositiveNote[];
  readonly opportunities: readonly CentralLearningOpportunity[];
  readonly materials: readonly CentralRuntimeMaterial[];
  readonly sourceRefs: readonly string[];
  /** The bounded source directory has further distinct, unconsumed original notices; no synthetic writes count. */
  readonly hasMore?: boolean;
  readonly reconsider?: readonly { readonly subject: CentralLearningSubject; readonly sourceRefs: readonly string[]; readonly reason: string }[];
}

export interface CentralRuntimeSourcePort {
  snapshot(scope: string, signal: AbortSignal, query?: { readonly subjects: readonly CentralLearningSubject[];
    readonly sourceRefs: readonly string[];
    /** Wake addresses select native records to authenticate; they are neither
     * observed source bodies nor permission to adopt the caller's subject. */
    readonly wakeSourceRefs?: readonly string[];
    /** Exact opportunity addresses offered to a successful complete agenda.
     * Separate from source exposure/read acknowledgements. */
    readonly consideredSourceRefs?: readonly string[];
    readonly purposes?: readonly { readonly subject: CentralLearningSubject; readonly sourceRefs: readonly string[];
      readonly purpose?: string }[] }): Promise<CentralRuntimeSnapshot>;
  read(scope: string, refs: readonly string[], maximumChars: number, signal: AbortSignal): Promise<readonly CentralRuntimeMaterial[]>;
}

export type CentralRuntimeWorkResult = { readonly outcome: "returned" | "failed" | "unknown";
  readonly publicResult: string; readonly resultRefs: readonly string[]; readonly wait?: CentralLearningWait };

export interface CentralRuntimeExecutionPort {
  consult(input: { readonly scope: string; readonly subject: CentralLearningSubject;
    readonly allowance: CentralLearningAllowance; readonly signal: AbortSignal }): Promise<CentralRuntimeMaterial>;
  prepare(input: { readonly scope: string; readonly intent: CentralLearningIntentDraft;
    readonly operation: Extract<CentralLearningOperation, { kind: "dispatch" }>;
    readonly configuration: CentralLearningConfiguration; readonly signal: AbortSignal }): Promise<CentralRuntimeWork>;
  execute(work: CentralRuntimeWork, signal: AbortSignal): Promise<CentralRuntimeWorkResult>;
  /** A missing/uncertain receipt never authorizes a blind replay. */
  recover(work: CentralRuntimeWork, signal: AbortSignal): Promise<CentralRuntimeWorkResult | { readonly kind: "ready_to_execute" } | null>;
}

export interface CentralRuntimeOrganizationPort {
  recall(input: { readonly scope: string; readonly state: CentralLearningRuntimeState;
    readonly opportunities: readonly CentralLearningOpportunity[]; readonly materials?: readonly CentralRuntimeMaterial[];
    readonly signal: AbortSignal }): Promise<readonly CentralRuntimeMaterial[]>;
  recordDecision?(input: { readonly request: CentralDeliberationRequest; readonly output: CentralDeliberationOutput;
    readonly decisionRef: string; readonly role?: "operation_expectation" | "deliberation";
    readonly effects?: "record_only";
    readonly deliveryRef?: string }, signal: AbortSignal): Promise<void | {
      /** The original decision is recorded. Materials describe actual publication
       * outcomes, including definite candidate refusals; they do not claim publication
       * or require checkpoint space. The original Board result receipt is authoritative. */
      readonly status: "recorded"; readonly materials: readonly CentralRuntimeMaterial[];
    }>;
  /** One eligible original refusal result, projected from the original Board
   * receipt. Reading it neither republishes knowledge nor creates evidence. */
  readPublicationCorrection?(input: { readonly scope: string; readonly state: CentralLearningRuntimeState;
    readonly consumedSourceRefs: readonly string[] }, signal: AbortSignal): Promise<readonly CentralRuntimeMaterial[]>;
  recordResult?(input: { readonly scope: string; readonly decisionRef: string;
    readonly completed: CentralCompletedOperation }, signal: AbortSignal): Promise<readonly CentralRuntimeMaterial[] | void>;
  /** Repair original completion→progress and delivery gaps before selecting work.
   * This read/append seam never creates a new business source or model wake. */
  recoverResults?(input: { readonly scope: string }, signal: AbortSignal): Promise<readonly CentralRuntimeMaterial[]>;
}

export interface CentralLearningDriverProgress {
  readonly state: "ready" | "waiting" | "ended";
  readonly reason: string;
  readonly sourceRefs: readonly string[];
  readonly wakeAt?: number;
  readonly providerWait?: import("./provider-positive.js").ProviderWaitDescriptor;
}

export interface CentralLearningDriveInput {
  readonly scope: string;
  readonly configuration: CentralLearningConfiguration;
  readonly wake: CentralLearningWake;
  readonly signal: AbortSignal;
  /** A returned worker publishes ready; the scope owner queues the next drive. */
  readonly publish: (progress: CentralLearningDriverProgress) => void | Promise<void>;
}

export interface CentralLearningDriver {
  drive(input: CentralLearningDriveInput): Promise<CentralLearningDriverProgress>;
  close?(): Promise<void>;
}
