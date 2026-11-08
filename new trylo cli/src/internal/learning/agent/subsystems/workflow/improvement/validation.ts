import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { workflowMatches } from "../domain/family.js";
import { workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowImprovement, WorkflowProcedure, WorkflowProcessTask, WorkflowProcessContract, WorkflowProcessEvidence } from "./contracts.js";
import { validateDeclaredProcessChanges } from "./revision.js";

export function workflowProcessKey(process: WorkflowProcessContract): string {
  return JSON.stringify([process.key, process.inputContract, process.outputContract, process.sideEffects, process.checkContract]);
}

/** Business-task labels may vary only behind an explicitly matched operation contract. */
export function workflowProcessMatches(left: WorkflowProcessTask, right: WorkflowProcessTask): boolean {
  if (left.scope !== right.scope) return false;
  if (left.process === undefined && right.process === undefined) return workflowMatches(left, right);
  return left.process !== undefined && right.process !== undefined
    && workflowProcessKey(left.process) === workflowProcessKey(right.process);
}

export function improvementApplies(artifact: WorkflowImprovement, task: WorkflowProcessTask): boolean {
  return workflowProcessMatches(artifact.opportunity.task, task)
    && Object.entries(artifact.proposal.procedure.requiredConditions)
      .every(([key, value]) => task.conditions?.[key] === value);
}

/** The host attests guards and adherence; this checks only the frozen recipe's complete identity set. */
export function workflowProcessEvidenceFits(artifact: WorkflowImprovement, evidence: WorkflowProcessEvidence): boolean {
  if (evidence.kind === "unverified") return true;

  const known = new Set(artifact.proposal.procedure.steps.map(step => step.id));
  if (evidence.checkedStepIds.length === 0 || evidence.evidenceRefs.length === 0
    || evidence.checkedStepIds.some(id => !known.has(id))) return false;

  if (evidence.kind === "partial") return new Set(evidence.checkedStepIds).size === evidence.checkedStepIds.length;

  const covered = [...evidence.checkedStepIds, ...evidence.skippedStepIds];

  return covered.length === known.size && new Set(covered).size === known.size && covered.every(id => known.has(id));
}

/** This proves reference integrity and an actionable proposal, never the causal hypothesis. */
export function validateImprovementBindings(artifact: WorkflowImprovement): WorkflowLearningResult<WorkflowImprovement> {
  const { opportunity, proposal, evidence } = artifact;
  const byRef = new Map(evidence.map(item => [item.ref, item]));
  const refs = [...opportunity.evidenceRefs, ...proposal.diagnosis.supportingRefs,
    ...proposal.diagnosis.counterEvidenceRefs, ...proposal.changes.flatMap(item => item.evidenceRefs)];
  if (refs.some(ref => !byRef.has(ref))) return workflowFailure("improvement_evidence_missing", "every diagnosis and change must bind the actual host evidence projection");

  const source = opportunity.evidenceRefs.map(ref => byRef.get(ref)!);
  if (opportunity.trigger === "user_correction"
    && !source.some(item => item.kind === "user_input" || item.kind === "user_correction")) {
    return workflowFailure("improvement_trigger_unsupported", "a proposed user correction must reference actual user input");
  }

  if (opportunity.trigger === "repeated_inefficiency"
    && new Set(source.filter(item => item.kind !== "context" && item.kind !== "user_input").map(item => item.ref)).size < 2) {
    return workflowFailure("improvement_trigger_unsupported", "repeated inefficiency needs at least two distinct observed execution facts");
  }

  const omitted = Object.entries(opportunity.task.conditions ?? {}).some(([key, value]) =>
    proposal.procedure.requiredConditions[key] !== value);
  // Observed task facts are not all permanent prerequisites. A researcher may
  // propose a different reuse boundary through an explicit evidence-bound reuse
  // change; scope, process effects/checks, permissions and quality remain separate.
  const revisesApplicability = proposal.changes.some(change => change.kind === "reuse" && change.evidenceRefs.length > 0);
  if (omitted && !revisesApplicability) return workflowFailure("improvement_conditions_weakened",
    "omitting observed applicability facts requires an explicit evidence-bound reuse change; silent deletion is invalid");

  if (Object.entries(proposal.procedure.requiredConditions).some(([key, value]) => opportunity.task.conditions?.[key] !== value)) {
    return workflowFailure("improvement_conditions_unsupported", "unknown applicability values must be probed, not invented as current facts");
  }

  return { ok: true, value: artifact };
}

export function validateImprovementRevision(artifact: WorkflowImprovement, parent: WorkflowImprovement): WorkflowLearningResult<WorkflowImprovement> {
  if (!workflowProcessMatches(artifact.opportunity.task, parent.opportunity.task) || artifact.opportunity.issueKey !== parent.opportunity.issueKey) {
    return workflowFailure("improvement_parent_mismatch", "revision must remain in the same problem, scope and complete task family");
  }

  if (procedureBehaviorKey(artifact.proposal.procedure) === procedureBehaviorKey(parent.proposal.procedure)) {
    return workflowFailure("improvement_unchanged", "rewriting the diagnosis without changing the procedure is not a process revision");
  }

  if (parent.proposal.procedure.qualityInvariants.some(requirement =>
    !artifact.proposal.procedure.qualityInvariants.includes(requirement))) {
    return workflowFailure("improvement_quality_weakened", "a process revision cannot silently drop the parent's quality requirements");
  }

  if (Object.keys(parent.proposal.procedure.requiredConditions).some(key =>
    artifact.proposal.procedure.requiredConditions[key] === undefined)
    && !artifact.proposal.changes.some(change => change.kind === "reuse" && change.evidenceRefs.length > 0)) {
    return workflowFailure("improvement_conditions_weakened", "a revision must explicitly justify applicability changes as evidence-bound reuse edits");
  }

  return validateDeclaredProcessChanges(artifact, parent);
}

/** Ignore titles, node renaming and prose about the diagnosis when checking progress.
 * Paraphrase equivalence still needs semantic feedback; this is not a proof of novelty. */
export function procedureBehaviorKey(procedure: WorkflowProcedure): string {
  const ids = new Map(procedure.steps.map((step, index) => [step.id, index]));
  // Case and quoted whitespace can change commands, field names or parser behavior.
  const normalized = (text: string) => text.trim();

  return JSON.stringify({
    requiredConditions: Object.entries(procedure.requiredConditions).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    assumptions: procedure.assumptions.map(item => normalized(item.check)),
    steps: procedure.steps.map(step => ({ action: normalized(step.action), inputs: step.inputs.map(normalized),
      outputs: step.outputs.map(normalized), dependsOn: step.dependsOn.map(id => ids.get(id)).sort(),
      when: step.when, verify: normalized(step.verify), onFailure: step.onFailure.action === "goto"
        ? { action: "goto", target: ids.get(step.onFailure.target), maxAttempts: step.onFailure.maxAttempts } : { action: step.onFailure.action } })),
    invalidation: procedure.invalidationSignals.map(normalized), stop: procedure.stopRules.map(normalized),
  });
}
