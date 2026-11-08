import type { CentralLearningAllowance, CentralLearningAgentDomain } from "../../learning/control/coordination-contract.js";

export const CENTRAL_LEARNING_CHANGE_TOOL = "submit_learning_change";

/** A handle is meaningful only in the one delivered request's typed dictionary. */
export type CentralChangeHandle = string;

export interface CentralChangeGrounding {
  readonly relation: string;
  readonly whenRelevant: string;
  readonly parents: readonly CentralChangeHandle[];
  readonly citations: readonly { readonly source: CentralChangeHandle; readonly quote?: string }[];
}

export interface CentralChangeKnowledge {
  readonly statement: string;
  readonly conditions: string;
  readonly sources: readonly CentralChangeHandle[];
}

export interface CentralChangeCommitment {
  readonly purpose: string;
  readonly assumptions: readonly string[];
  readonly reconsiderWhen: readonly string[];
}

type Investment = Pick<CentralLearningAllowance, "maxTokens" | "maxCalls" | "maxSteps" | "maxPromptChars">;

interface OperationMeaning {
  readonly purpose: string;
  readonly expectedChange: string;
  readonly sources: readonly CentralChangeHandle[];
}

export type CentralChangeNext =
  | OperationMeaning & { readonly kind: "think"; readonly maxOutputTokens?: number }
  | OperationMeaning & { readonly kind: "read"; readonly refs: readonly CentralChangeHandle[]; readonly maximumChars: number }
  | OperationMeaning & { readonly kind: "query"; readonly plane: "knowledge" | "organization"; readonly query: string;
      readonly offset?: number; readonly maximumChars: number }
  | OperationMeaning & { readonly kind: "consult"; readonly allowance: Investment }
  | OperationMeaning & { readonly kind: "dispatch"; readonly allowance: Investment;
      readonly destination?: { readonly plane: "agent"; readonly domain: CentralLearningAgentDomain } | { readonly plane: "user" } }
  | { readonly kind: "wait"; readonly for: "facts" | "use_feedback" | "resources"; readonly sources: readonly CentralChangeHandle[]; readonly reason: string }
  | { readonly kind: "wait_until"; readonly at: number; readonly sources: readonly CentralChangeHandle[]; readonly reason: string }
  | { readonly kind: "end"; readonly goalState: "open" | "answered" | "withdrawn"; readonly reason: string };

export interface CentralChangeFields {
  readonly goal?: string;
  readonly rationale?: string;
  readonly conditions?: readonly string[];
  readonly knowledge?: readonly CentralChangeKnowledge[];
  readonly residual?: readonly string[];
  readonly commitment?: CentralChangeCommitment;
  readonly sources?: readonly CentralChangeHandle[];
  readonly grounding?: CentralChangeGrounding;
  readonly next?: CentralChangeNext;
}

export type CentralIntentChange =
  | { readonly kind: "create"; readonly key: string; readonly subject: "central" | CentralChangeHandle;
      readonly goal: string; readonly why: string; readonly grounding?: CentralChangeGrounding; readonly next: CentralChangeNext;
      readonly conditions?: readonly string[]; readonly knowledge?: readonly CentralChangeKnowledge[];
      readonly residual?: readonly string[]; readonly commitment?: CentralChangeCommitment; readonly sources?: readonly CentralChangeHandle[] }
  | { readonly kind: "revise"; readonly target: CentralChangeHandle; readonly why: string; readonly set: CentralChangeFields }
  | { readonly kind: "end"; readonly target: CentralChangeHandle; readonly goalState: "open" | "answered" | "withdrawn"; readonly why: string };

export interface CentralOrganizationChangeFields {
  readonly statement?: string;
  readonly conditions?: string;
  readonly conditionKeys?: readonly string[];
  readonly exceptions?: string;
  readonly exceptionKeys?: readonly string[];
  readonly implication?: string;
  readonly support?: readonly CentralChangeHandle[];
  readonly counterexamples?: readonly CentralChangeHandle[];
}

export type CentralOrganizationChange =
  | { readonly kind: "propose"; readonly key: string; readonly statement: string; readonly conditions: string; readonly implication: string;
      readonly support: readonly CentralChangeHandle[]; readonly conditionKeys?: readonly string[]; readonly exceptions: string;
      readonly exceptionKeys?: readonly string[]; readonly counterexamples?: readonly CentralChangeHandle[] }
  | { readonly kind: "revise" | "withdraw"; readonly target: CentralChangeHandle; readonly why: string; readonly set: CentralOrganizationChangeFields };

export interface CentralLearningChange {
  /** The transport already binds this call. An explicit checkpoint, when supplied, must match. */
  readonly checkpoint?: string;
  readonly changes: readonly CentralIntentChange[];
  /** Read an original before a purpose can honestly be grounded in it. */
  readonly inspect?: { readonly purpose: string; readonly expectedChange: string; readonly refs: readonly CentralChangeHandle[];
    readonly maximumChars: number; readonly sources?: readonly CentralChangeHandle[] };
  readonly explanation: string;
  /** Omission preserves agenda order; a named existing handle or new local key moves only that purpose first. */
  readonly next?: string;
  readonly sources?: readonly CentralChangeHandle[];
  readonly alternatives?: readonly string[];
  readonly organizationUse?: { readonly recall: CentralChangeHandle; readonly changes: readonly {
    readonly knowledge: CentralChangeHandle; readonly choice: "program" | "investment" | "timing" | "wait" | "unchanged";
    readonly before: string; readonly after: string; readonly reason: string }[] };
  readonly organizationKnowledge?: readonly CentralOrganizationChange[];
}
