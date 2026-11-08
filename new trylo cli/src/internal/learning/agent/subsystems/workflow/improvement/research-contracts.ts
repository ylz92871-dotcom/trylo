/** Public, revisable working understanding; never a new observation or quality verdict. */
export type WorkflowResearchFinding = {
  readonly kind: "hypothesis" | "interpretation" | "counterexample" | "open_question";
  readonly statement: string;
  readonly conditions: string;
  readonly sourceRefs: readonly string[];
  readonly nextQuestion?: string;
};

/** Confirmed local research receipts. A request alone does not expose its target. */
export type WorkflowResearchObservation =
  | { readonly kind: "material_read"; readonly evidenceRefs: readonly string[] }
  | { readonly kind: "versions_compared"; readonly versionIds: readonly string[] }
  | { readonly kind: "finding_recorded"; readonly finding: WorkflowResearchFinding }
  | { readonly kind: "invalid_response"; readonly code: string; readonly message: string };

/** Research controls consume the original grant; they confer no business authority. */
export type WorkflowResearchAction<Proposal> =
  | { readonly kind: "read_material"; readonly evidenceRefs: readonly string[] }
  | { readonly kind: "compare_versions"; readonly versionIds: readonly string[] }
  | { readonly kind: "record_finding"; readonly finding: WorkflowResearchFinding }
  | { readonly kind: "propose"; readonly proposal: Proposal }
  | { readonly kind: "wait_for_evidence"; readonly reason: string; readonly evidenceRefs: readonly string[] }
  | { readonly kind: "stop"; readonly reason: string };

/** Context and proposal remain owned by the existing workflow contract. */
export type WorkflowResearchInput<Context> = Context & {
  readonly observations: readonly WorkflowResearchObservation[];
};

/** Latest call only. Missing/incomplete usage retains the bounded call reservation. */
export type WorkflowResearchUsage = {
  readonly calls: number;
  readonly tokens: number;
  readonly observedTokens: number;
  readonly uncertain: boolean;
};
