import type { WorkflowLearningArtifact, WorkflowLearningResult, WorkflowTask } from "./trace-contracts.js";
import { workflowMatches } from "./family.js";

/** Shared by prompt compilation, execution and feedback validation. No state is written. */
export function selectWorkflowPath(
  artifact: WorkflowLearningArtifact,
  task: WorkflowTask,
): WorkflowLearningResult<{ readonly artifact: WorkflowLearningArtifact; readonly adoptedBranchId?: string }> {
  if (!workflowMatches(artifact, task)) return { ok: false, code: "not_applicable", message: "workflow scope or task-family premises differ" };

  if (artifact.schemaVersion === 1) return artifact.mode === "path"
    ? { ok: true, value: { artifact } }
    : { ok: false, code: "lessons_only", message: "failure lessons supply no supported execution path" };

  const branches = artifact.branches ?? [];
  const declaredKeys = new Set(branches.flatMap(branch => Object.keys(branch.when)));
  if ([...declaredKeys].some(key => task.conditions?.[key] === undefined)) {
    return { ok: false, code: "condition_unknown", message: "every learned condition dimension requires an observed task value" };
  }

  // A legacy observation lacking a newly discovered premise cannot become an
  // unconditional fallback around an evidenced exception.
  const matches = branches.filter(branch => [...declaredKeys].every(key =>
    branch.when[key] !== undefined && task.conditions?.[key] === branch.when[key]));
  const specificity = Math.max(-1, ...matches.map(branch => Object.keys(branch.when).length));
  const mostSpecific = matches.filter(branch => Object.keys(branch.when).length === specificity);
  if (mostSpecific.length !== 1) return { ok: false, code: mostSpecific.length === 0 ? "condition_unknown" : "condition_ambiguous",
    message: "observed task conditions must identify exactly one supported branch" };

  const branch = mostSpecific[0]!;
  if (branch.mode !== "path") return { ok: false, code: "lessons_only", message: "this condition has failure lessons but no supported path" };

  return { ok: true, value: { adoptedBranchId: branch.id, artifact: { ...artifact,
    nodes: branch.nodes, recovery: branch.recovery, mode: branch.mode,
    positiveEvidenceRefs: branch.positiveEvidenceRefs, negativeEvidenceRefs: branch.negativeEvidenceRefs } } };
}
