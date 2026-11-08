import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { CentralRuntimeMaterial } from "../../../../central/runtime/contracts.js";
import type { WorkflowProcessTask, WorkflowImprovementEvidence } from "../improvement/contracts.js";
import { parseWorkflowProcessTask } from "../improvement/parse.js";
import type { WorkflowImprovementOpportunityRecord } from "../runtime/improvement-contracts.js";

export interface WorkflowCentralResearchPurpose {
  readonly requestRef: string;
  readonly intentRef: string;
  readonly goal: string;
  readonly rationale: string;
  readonly conditions: readonly string[];
  readonly citations: readonly { readonly evidenceRef: string; readonly quote: string }[];
  readonly materials: readonly CentralRuntimeMaterial[];
  /** Original request/episode navigation, explicitly derived rather than new observations. */
  readonly lineageEvidence?: readonly { readonly ref: string; readonly summary: string }[];
}

export type WorkflowCentralResearchSource = { readonly status: "ready"; readonly record: WorkflowImprovementOpportunityRecord }
  | { readonly status: "waiting"; readonly reason: string; readonly sourceRefs: readonly string[] };

/** Only complete, explicit source task contracts are inherited. A research
 * target describes a future use; it never asserts an execution/check occurred. */
function sourceTasks(materials: readonly CentralRuntimeMaterial[], scope: string): readonly WorkflowProcessTask[] {
  const tasks = new Map<string, WorkflowProcessTask>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || typeof value !== "object" || value === null) return;

    const parsed = parseWorkflowProcessTask(value);
    if (parsed.ok && parsed.value.scope === scope) tasks.set(canonicalJson(parsed.value), parsed.value);

    for (const nested of Object.values(value)) {
      if (typeof nested === "string") continue;
      visit(nested, depth + 1);
    }
  };

  for (const material of materials) {
    let body: unknown;
    try { body = JSON.parse(material.text); }
    catch { continue; } // Plain text remains quoted evidence; it cannot establish a structured task contract.
    visit(body, 0);
  }

  return [...tasks.values()];
}

export function buildWorkflowCentralResearchSource(input: WorkflowCentralResearchPurpose, scope: string): WorkflowCentralResearchSource {
  const waiting = (reason: string): WorkflowCentralResearchSource => ({ status: "waiting", reason,
    sourceRefs: [...new Set([input.intentRef, ...input.citations.map(row => row.evidenceRef)])] });

  if (!input.goal.trim() || input.goal.length > 4096 || input.rationale.length > 3500
    || input.citations.length === 0 || input.citations.length > 32
    || input.citations.some(row => !row.quote.trim() || row.quote.length > 4096)
    || input.conditions.length > 14 || input.conditions.some(row => !row.trim() || row.length > 4096)) {
    return waiting("workflow_research_request_native_capacity");
  }

  const inherited = sourceTasks(input.materials, scope);
  if (inherited.length > 1) return waiting("workflow_research_requires_one_applicable_task_contract");

  const prospective: WorkflowProcessTask = { scope, taskFamily: {
    id: `central-prospective-process:${contentHashOf([input.goal, input.conditions])}`,
    intentClass: input.goal, checkKind: "acceptance", checkSchema: "source-grounded-prospective-process/v1" },
    // Intent conditions are proposed assumptions, not currently observed key /
    // value business facts. The actual research worker sees them in its central
    // context and must retain observable assumption checks in the procedure.
    conditions: {} };
  const evidence: WorkflowImprovementEvidence[] = input.citations.map(row => ({ ref: row.evidenceRef, kind: "context", summary: row.quote }));

  evidence.push({ ref: input.intentRef, kind: "context", summary:
    `Central derived research request; not an external observation, user command or verified outcome. ${input.rationale}` });

  for (const item of input.lineageEvidence ?? []) evidence.push({ ...item, kind: "context" });

  const uniqueEvidence = [...new Map(evidence.map(row => [row.ref, row])).values()];
  if (uniqueEvidence.length > 32 || uniqueEvidence.some(row => row.summary.length > 4096)) return waiting("workflow_research_request_native_capacity");

  return { status: "ready", record: { type: "workflow_improvement_opportunity", schemaVersion: 1,
    opportunity: { opportunityId: input.requestRef, issueKey: input.requestRef,
      task: inherited[0] ?? prospective, trigger: "central_research", problem: input.goal, desiredOutcome: input.goal,
      evidenceRefs: uniqueEvidence.map(row => row.ref) }, evidence: uniqueEvidence } };
}
