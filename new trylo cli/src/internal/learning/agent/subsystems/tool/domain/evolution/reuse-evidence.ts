import { contentHashOf } from "../../../../../control/hash.js";
import type { ToolEvolutionSample } from "./contracts.js";
import type { ToolTaskFeedback } from "./task-feedback.js";

export type ToolReuseContractEvidence = {
  readonly toolId: string;
  readonly versionId: string;
  readonly contractHash: string;
  readonly implementationHash: string;
  readonly taskExamples: { readonly matchingRefs: readonly string[]; readonly conflictingRefs: readonly string[]; readonly uncoveredRefs: readonly string[] };
  readonly contractScope: { readonly sourceCases: number; readonly heldOutCases: number; readonly generalization: "not_established" };
  /** Exact source/runtime + input schema, not semantic equivalence or permission to merge tools. */
  readonly sameImplementationAs: readonly { readonly toolId: string; readonly versionId: string }[];
  readonly taskAssessments: readonly { readonly feedbackRef: string; readonly situation: string; readonly outcome: ToolTaskFeedback["outcome"];
    readonly recommendation: ToolTaskFeedback["recommendation"]; readonly returnedUseIds: readonly string[]; readonly reportedBy: "user" | "verifier" }[];
};

export type ToolReuseTaskSample = { readonly ref: string; readonly sample: ToolEvolutionSample };

/** Compare known contracts only. A match says nothing about unseen inputs, and
 * absent examples are unknown rather than passing or failing conformance. */
export function toolReuseExampleCoverage(samples: readonly ToolEvolutionSample[], task: readonly ToolReuseTaskSample[]): ToolReuseContractEvidence["taskExamples"] {
  const matchingRefs: string[] = [], conflictingRefs: string[] = [], uncoveredRefs: string[] = [];

  for (const row of task) {
    const known = samples.filter(sample => contentHashOf(sample.input) === contentHashOf(row.sample.input));
    const target = known.length === 0 ? uncoveredRefs : known.every(sample => contentHashOf(sample.expected) === contentHashOf(row.sample.expected))
      ? matchingRefs : conflictingRefs;
    if (!target.includes(row.ref)) target.push(row.ref);
  }

  return { matchingRefs, conflictingRefs, uncoveredRefs };
}

/** Concrete task-contract evidence outranks lexical similarity. No success-count
 * score is used: a frequently called tool can still be a bad fit for this task. */
export function orderToolReuseByContract<T extends { readonly toolId: string; readonly versionId?: string }>(tools: readonly T[],
  evidence: readonly ToolReuseContractEvidence[], targetVersionId?: string): readonly T[] {
  const rank = (tool: T) => {
    const known = evidence.find(row => row.toolId === tool.toolId && row.versionId === tool.versionId)?.taskExamples;
    if (known === undefined || known.matchingRefs.length + known.conflictingRefs.length + known.uncoveredRefs.length === 0) return 2;
    if (known.conflictingRefs.length > 0) return 3;
    return known.matchingRefs.length === 0 ? 2 : known.uncoveredRefs.length === 0 ? 0 : 1;
  };
  return tools.map((tool, order) => ({ tool, order })).sort((left, right) =>
    Number(right.tool.versionId === targetVersionId && targetVersionId !== undefined) - Number(left.tool.versionId === targetVersionId && targetVersionId !== undefined)
    || rank(left.tool) - rank(right.tool) || left.order - right.order).map(row => row.tool);
}
