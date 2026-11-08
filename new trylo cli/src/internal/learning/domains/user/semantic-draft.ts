import { POLICY_DIMENSIONS, ELIGIBILITY_CLASSES, type EligibilityClass, type PolicyDimension } from "./contracts.js";

export type UserSemanticDraft = {
  readonly schemaVersion: 1;
  readonly eligibility: readonly { readonly evidenceId: string; readonly classification: EligibilityClass; readonly rationale: string }[];
  readonly conclusions: readonly { readonly key: string; readonly statement: string; readonly dimension: PolicyDimension;
    readonly evidenceIds: readonly string[]; readonly counterEvidenceIds: readonly string[]; readonly conditions: string }[];
  readonly models: readonly { readonly key: string; readonly conclusionKeys: readonly string[]; readonly statement: string;
    readonly distance: "D0" | "D1" | "D2"; readonly alternatives: readonly string[] }[];
  readonly policies: readonly { readonly modelKey: string; readonly instruction: string; readonly applicability: string;
    readonly includeTerms: readonly string[]; readonly excludeTerms: readonly string[]; readonly evidenceIds: readonly string[] }[];
  readonly policyRevisions?: readonly { readonly ruleId: string; readonly action: "pause" | "replace";
    readonly evidenceId: string; readonly quote: string; readonly reason: string }[];
  readonly progress: { readonly state: "continue" | "clarification" | "completed" | "no_result";
    readonly understanding: string; readonly remaining: string; readonly nextAction: string; readonly clarification: string | null };
};

export function objectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function boundedText(value: unknown, maximum = 4096): value is string {
  return typeof value === "string" && value.length <= maximum;
}

export function stringList(value: unknown, maximum = 32): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(item => boundedText(item, 1024));
}

function listOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.length <= 32 && value.every(guard);
}

const nonempty = (value: unknown): value is string => boundedText(value) && value.trim().length > 0;
const isEligibility = (value: unknown): value is UserSemanticDraft["eligibility"][number] => objectValue(value)
  && nonempty(value.evidenceId) && ELIGIBILITY_CLASSES.some(item => item === value.classification) && nonempty(value.rationale);
const isConclusion = (value: unknown): value is UserSemanticDraft["conclusions"][number] => objectValue(value)
  && nonempty(value.key) && nonempty(value.statement) && POLICY_DIMENSIONS.some(item => item === value.dimension)
  && stringList(value.evidenceIds) && stringList(value.counterEvidenceIds) && nonempty(value.conditions);
const isModel = (value: unknown): value is UserSemanticDraft["models"][number] => objectValue(value)
  && nonempty(value.key) && nonempty(value.statement) && stringList(value.conclusionKeys)
  && ["D0", "D1", "D2"].includes(String(value.distance)) && stringList(value.alternatives);
const isPolicy = (value: unknown): value is UserSemanticDraft["policies"][number] => objectValue(value)
  && nonempty(value.modelKey) && nonempty(value.instruction) && nonempty(value.applicability)
  && stringList(value.includeTerms) && stringList(value.excludeTerms) && stringList(value.evidenceIds);
const isRevision = (value: unknown): value is NonNullable<UserSemanticDraft["policyRevisions"]>[number] => objectValue(value)
  && nonempty(value.ruleId) && (value.action === "pause" || value.action === "replace")
  && nonempty(value.evidenceId) && nonempty(value.quote) && nonempty(value.reason);

/** Reject malformed model output before it can become an immutable User version. */
export function readUserSemanticDraft(value: unknown): UserSemanticDraft | undefined {
  if (!objectValue(value) || value.schemaVersion !== 1 || !listOf(value.eligibility, isEligibility)
    || !listOf(value.conclusions, isConclusion) || !listOf(value.models, isModel) || !listOf(value.policies, isPolicy)
    || value.policyRevisions !== undefined && !listOf(value.policyRevisions, isRevision)
    || !objectValue(value.progress)) return undefined;

  const progress = value.progress;
  if (!["continue", "clarification", "completed", "no_result"].includes(String(progress.state))
    || !boundedText(progress.understanding) || !boundedText(progress.remaining) || !boundedText(progress.nextAction)
    || !(progress.clarification === null || nonempty(progress.clarification))) return undefined;

  if (progress.state === "continue" && !nonempty(progress.nextAction)
    || progress.state === "clarification" && !nonempty(progress.clarification)) return undefined;

  // All nested values were checked above; this is a single validated serialization boundary.
  return value as UserSemanticDraft;
}
