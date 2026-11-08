import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { parseWorkflowTask, record, workflowFailure } from "../domain/trace-parse.js";
import { scanForbiddenBody } from "../../../../domains/shared/forbidden-scan.js";
import { validateImprovementBindings } from "./validation.js";
import type {
  WorkflowDiagnosis, WorkflowImprovement, WorkflowImprovementEvidence,
  WorkflowImprovementFeedback, WorkflowImprovementProposal, WorkflowOpportunity,
  WorkflowProcedure, WorkflowProcedureStep, WorkflowProcessChange,
  WorkflowProcessTask,
  WorkflowProcessEvidence,
} from "./contracts.js";

const MAX_TEXT = 4096;
const MAX_ITEMS = 32;

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT;
}

function texts(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_ITEMS && value.every(text)
    && new Set(value).size === value.length;
}

function map(value: unknown): value is Readonly<Record<string, string>> {
  return record(value) && Object.keys(value).length <= MAX_ITEMS
    && Object.entries(value).every(([key, item]) => text(key) && text(item));
}

function failure(message: string) {
  return workflowFailure("invalid_workflow_improvement", message);
}

function safe(value: unknown): boolean {
  const json = JSON.stringify(value);
  // A proposed workflow may include ordinary fetching and may change its own graph.
  // These are task actions, not authority. The execution Permission owner still decides.
  const claims = scanForbiddenBody([json]).filter(hit => hit !== "download" && hit !== "workflow_topology");
  return json.length <= 131072 && claims.length === 0;
}

export function parseWorkflowProcessTask(value: unknown): WorkflowLearningResult<WorkflowProcessTask> {
  const task = parseWorkflowTask(value);
  if (!task.ok) return task;

  if (!record(value) || value.process === undefined) return task;

  const process = value.process;
  if (!record(process) || !text(process.key) || !text(process.inputContract) || !text(process.outputContract)
    || !text(process.checkContract) || !["read_only", "local_artifact", "external"].includes(String(process.sideEffects))) {
    return failure("a transferable process needs explicit input/output, side-effect and check contracts");
  }

  return { ok: true, value: { ...task.value, process: { key: process.key, inputContract: process.inputContract,
    outputContract: process.outputContract, checkContract: process.checkContract,
    sideEffects: process.sideEffects as NonNullable<WorkflowProcessTask["process"]>["sideEffects"] } } };
}

export function parseWorkflowOpportunity(value: unknown): WorkflowLearningResult<WorkflowOpportunity> {
  if (!record(value) || !text(value.opportunityId) || !text(value.issueKey)
    || !text(value.problem) || !text(value.desiredOutcome)
    || !texts(value.evidenceRefs) || value.evidenceRefs.length === 0
    || (value.affectedStepIds !== undefined && (!texts(value.affectedStepIds)
      || value.affectedStepIds.length === 0 || value.affectedStepIds.length > 8))
    || !["repeated_inefficiency", "user_correction", "central_research"].includes(String(value.trigger))) {
    return failure("an opportunity needs a stable issue, concrete problem, desired change and evidence references");
  }

  const task = parseWorkflowProcessTask(value.task);
  if (!task.ok) return task;

  const opportunity: WorkflowOpportunity = { opportunityId: value.opportunityId, issueKey: value.issueKey,
    task: task.value, trigger: value.trigger as WorkflowOpportunity["trigger"], problem: value.problem,
    desiredOutcome: value.desiredOutcome, evidenceRefs: [...value.evidenceRefs],
    ...(value.affectedStepIds === undefined ? {} : { affectedStepIds: [...value.affectedStepIds] }) };

  return safe(opportunity) ? { ok: true, value: opportunity } : failure("opportunities cannot carry authority claims");
}

export function parseWorkflowImprovementEvidence(value: unknown): WorkflowLearningResult<readonly WorkflowImprovementEvidence[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) return failure("bounded host evidence is required");

  const evidence: WorkflowImprovementEvidence[] = [];

  for (const item of value) {
    if (!record(item) || !text(item.ref) || !text(item.summary)
      || !["tool_success", "tool_failure", "quality_failure", "user_input", "user_correction", "rework", "context"].includes(String(item.kind))
      || (item.executionId !== undefined && !text(item.executionId))
      || (item.sourceVersionId !== undefined && !text(item.sourceVersionId))) return failure("invalid host evidence projection");
    evidence.push({ ref: item.ref, kind: item.kind as WorkflowImprovementEvidence["kind"], summary: item.summary,
      ...(item.executionId === undefined ? {} : { executionId: item.executionId }),
      ...(item.sourceVersionId === undefined ? {} : { sourceVersionId: item.sourceVersionId }) });
  }

  return new Set(evidence.map(item => item.ref)).size !== evidence.length ? failure("evidence references must be unique")
    : { ok: true, value: evidence };
}

function diagnosis(value: unknown): WorkflowLearningResult<WorkflowDiagnosis> {
  if (!record(value) || !text(value.hypothesis) || !texts(value.supportingRefs) || value.supportingRefs.length === 0
    || !texts(value.counterEvidenceRefs) || !texts(value.alternatives) || value.alternatives.length === 0
    || !texts(value.discriminateBy) || value.discriminateBy.length === 0) {
    return failure("diagnosis needs evidence, alternatives and an observable way to challenge the hypothesis");
  }
  return { ok: true, value: { hypothesis: value.hypothesis, supportingRefs: [...value.supportingRefs],
    counterEvidenceRefs: [...value.counterEvidenceRefs], alternatives: [...value.alternatives], discriminateBy: [...value.discriminateBy] } };
}

function step(value: unknown): WorkflowLearningResult<WorkflowProcedureStep> {
  if (!record(value) || !text(value.id) || !text(value.action) || !texts(value.inputs) || !texts(value.outputs)
    || value.outputs.length === 0 || !texts(value.dependsOn) || !text(value.verify) || !record(value.onFailure)
    || !text(value.onFailure.reason)) return failure("every procedure step needs action, IO, dependencies, a check and failure behavior");

  const raw = value.onFailure;
  let onFailure: WorkflowProcedureStep["onFailure"];

  if (raw.action === "goto" && text(raw.target) && Number.isSafeInteger(raw.maxAttempts)
    && Number(raw.maxAttempts) > 0 && Number(raw.maxAttempts) <= 16) {
    onFailure = { action: "goto", target: raw.target, maxAttempts: Number(raw.maxAttempts), reason: raw.reason as string };
  }
  else if (raw.action === "replan" || raw.action === "stop") onFailure = { action: raw.action, reason: raw.reason as string };
  else return failure("a failure branch must stop, replan or name a recovery step with a bounded attempt limit");

  if (value.when !== undefined && (!record(value.when) || !text(value.when.fact) || !text(value.when.equals))) {
    return failure("conditional steps require an observable fact and its literal value");
  }

  return { ok: true, value: { id: value.id, action: value.action, inputs: [...value.inputs], outputs: [...value.outputs],
    dependsOn: [...value.dependsOn], verify: value.verify, onFailure,
    ...(value.when === undefined ? {} : { when: { fact: String(value.when.fact), equals: String(value.when.equals) } }) } };
}

function procedure(value: unknown): WorkflowLearningResult<WorkflowProcedure> {
  if (!record(value) || !text(value.name) || !map(value.requiredConditions) || !Array.isArray(value.steps)
    || value.steps.length < 1 || value.steps.length > MAX_ITEMS || !Array.isArray(value.assumptions)
    || value.assumptions.length === 0 || value.assumptions.length > MAX_ITEMS
    || !texts(value.qualityInvariants) || value.qualityInvariants.length === 0
    || !texts(value.invalidationSignals) || value.invalidationSignals.length === 0
    || !texts(value.stopRules) || value.stopRules.length === 0) return failure("a procedure needs a bounded action graph, applicability, checked assumptions, quality and invalidation/stop rules");

  const steps: WorkflowProcedureStep[] = [], assumptions: { claim: string; check: string }[] = [];
  const prior = new Set<string>();

  for (const item of value.steps) {
    const parsed = step(item);
    if (!parsed.ok) return parsed;
    if (prior.has(parsed.value.id) || parsed.value.dependsOn.some(id => !prior.has(id))) {
      return failure("step identities must be unique and dependencies must name earlier steps");
    }
    prior.add(parsed.value.id);
    steps.push(parsed.value);
  }

  if (steps.some(item => item.onFailure.action === "goto" && !prior.has(item.onFailure.target))) {
    return failure("recovery must name an existing step");
  }

  for (const item of value.assumptions) {
    if (!record(item) || !text(item.claim) || !text(item.check)) return failure("every assumption requires an observable check");
    assumptions.push({ claim: item.claim, check: item.check });
  }

  return { ok: true, value: { name: value.name, requiredConditions: { ...value.requiredConditions }, assumptions, steps,
    qualityInvariants: [...value.qualityInvariants], invalidationSignals: [...value.invalidationSignals], stopRules: [...value.stopRules] } };
}

export function parseWorkflowImprovementProposal(value: unknown): WorkflowLearningResult<WorkflowImprovementProposal> {
  if (!record(value) || !Array.isArray(value.changes) || value.changes.length === 0 || value.changes.length > MAX_ITEMS) {
    return failure("a proposal must explain at least one concrete change to the costly process");
  }

  const cause = diagnosis(value.diagnosis);
  if (!cause.ok) return cause;

  const plan = procedure(value.procedure);
  if (!plan.ok) return plan;

  const changes: WorkflowProcessChange[] = [];

  for (const item of value.changes) {
    if (!record(item) || !["replace", "insert", "remove", "reorder", "branch", "reuse", "stop_rule"].includes(String(item.kind))
      || !texts(item.stepIds) || item.stepIds.length === 0 || !text(item.before) || !text(item.after)
      || item.before.trim() === item.after.trim() || !text(item.rationale) || !text(item.expectedEffect)
      || !texts(item.evidenceRefs) || item.evidenceRefs.length === 0) return failure("changes must identify before/after behavior, affected steps, evidence and expected benefit");

    if (item.kind !== "remove" && item.stepIds.some(id => !plan.value.steps.some(node => node.id === id))) {
      return failure("a process change must bind actual procedure steps");
    }

    changes.push({ kind: item.kind as WorkflowProcessChange["kind"], stepIds: [...item.stepIds], before: item.before,
      after: item.after, rationale: item.rationale, expectedEffect: item.expectedEffect, evidenceRefs: [...item.evidenceRefs] });
  }

  const proposal = { diagnosis: cause.value, procedure: plan.value, changes };

  return safe(proposal) ? { ok: true, value: proposal } : failure("workflow guidance cannot carry authority claims");
}

export function parseWorkflowImprovement(value: unknown): WorkflowLearningResult<WorkflowImprovement> {
  if (!record(value) || value.type !== "workflow_improvement" || value.schemaVersion !== 1 || value.claim !== "proposed_improvement"
    || (value.parentVersionId !== undefined && !text(value.parentVersionId))) return failure("unsupported improvement asset format");

  const opportunity = parseWorkflowOpportunity(value.opportunity);
  if (!opportunity.ok) return opportunity;

  const evidence = parseWorkflowImprovementEvidence(value.evidence);
  if (!evidence.ok) return evidence;

  const proposal = parseWorkflowImprovementProposal(value.proposal);
  if (!proposal.ok) return proposal;

  return validateImprovementBindings({ schemaVersion: 1, type: "workflow_improvement", opportunity: opportunity.value,
    proposal: proposal.value, evidence: evidence.value, claim: "proposed_improvement",
    ...(value.parentVersionId === undefined ? {} : { parentVersionId: value.parentVersionId }) });
}

export function parseWorkflowProcessEvidence(value: unknown): WorkflowLearningResult<WorkflowProcessEvidence> {
  if (!record(value)) return failure("process evidence must come from an independent host checker");

  if (value.kind === "unverified") return { ok: true, value: { kind: "unverified" } };

  if ((value.kind !== "partial" && value.kind !== "complete") || !text(value.checkerRef)
    || !texts(value.evidenceRefs) || value.evidenceRefs.length === 0 || !texts(value.checkedStepIds)
    || value.checkedStepIds.length === 0) return failure("observed process evidence needs a checker, actual receipts and checked steps");

  const common = { checkerRef: value.checkerRef, evidenceRefs: [...value.evidenceRefs], checkedStepIds: [...value.checkedStepIds] };

  if (value.kind === "partial") return { ok: true, value: { kind: "partial", ...common } };

  if (!texts(value.skippedStepIds) || value.skippedStepIds.some(id => common.checkedStepIds.includes(id))) {
    return failure("complete process evidence must separate observed steps from independently justified skipped branches");
  }

  return { ok: true, value: { kind: "complete", ...common, skippedStepIds: [...value.skippedStepIds] } };
}

export function parseWorkflowImprovementFeedback(value: unknown): WorkflowLearningResult<WorkflowImprovementFeedback> {
  if (!record(value) || !text(value.feedbackId) || !text(value.useId) || !text(value.versionId) || !text(value.executionId)
    || !["reported_used", "skipped"].includes(String(value.exposure)) || !["passed", "failed", "unknown"].includes(String(value.quality))
    || !texts(value.evidenceRefs) || !texts(value.followedStepIds) || !text(value.explanation)) return failure("feedback must identify its adopted use, exposure and actual evidence");

  const task = parseWorkflowProcessTask(value.task);
  if (!task.ok) return task;

  const processEvidence = value.processEvidence === undefined ? undefined : parseWorkflowProcessEvidence(value.processEvidence);
  if (processEvidence !== undefined && !processEvidence.ok) return processEvidence;

  let userAssessment: WorkflowImprovementFeedback["userAssessment"];
  if (value.userAssessment !== undefined) {
    const assessment = value.userAssessment;
    if (!record(assessment) || !["helped", "harmed", "neutral"].includes(String(assessment.judgment))
      || !text(assessment.evidenceRef)) return failure("user assessment needs an explicit user action reference");
    userAssessment = { judgment: assessment.judgment as "helped" | "harmed" | "neutral", evidenceRef: assessment.evidenceRef };
  }

  const raw = value.comparison;
  let comparison: WorkflowImprovementFeedback["comparison"];

  if (raw !== undefined) {
    if (!record(raw) || !text(raw.comparisonKey) || !text(raw.baselineExecutionId) || !text(raw.candidateExecutionId)
      || raw.baselineExecutionId === raw.candidateExecutionId || !["passed", "failed"].includes(String(raw.baselineQuality))
      || !["tokens", "wall_ms", "tool_calls", "rework_steps"].includes(String(raw.unit))
      || !Number.isFinite(raw.baselineCost) || Number(raw.baselineCost) < 0
      || !Number.isFinite(raw.candidateCost) || Number(raw.candidateCost) < 0
      || !texts(raw.evidenceRefs) || raw.evidenceRefs.length < 2) return failure("cost comparison needs distinct measured executions, a matched context/check/input key and evidence on both sides");
    comparison = { comparisonKey: raw.comparisonKey, baselineExecutionId: raw.baselineExecutionId,
      candidateExecutionId: raw.candidateExecutionId, baselineQuality: raw.baselineQuality as "passed" | "failed",
      baselineCost: Number(raw.baselineCost), candidateCost: Number(raw.candidateCost),
      unit: raw.unit as NonNullable<WorkflowImprovementFeedback["comparison"]>["unit"], evidenceRefs: [...raw.evidenceRefs] };
  }

  if (value.exposure === "skipped" && (value.quality !== "unknown" || comparison !== undefined
      || processEvidence?.value.kind === "complete")
    || value.quality !== "unknown" && (value.evidenceRefs.length === 0 || value.followedStepIds.length === 0
      && (processEvidence === undefined || processEvidence.value.kind === "unverified"))) {
    return failure("skips and unobserved interventions cannot claim quality or causal improvement");
  }

  if (comparison !== undefined && comparison.candidateExecutionId !== value.executionId) {
    return failure("a cost comparison must measure this feedback's actual candidate execution");
  }

  return { ok: true, value: { feedbackId: value.feedbackId, useId: value.useId, versionId: value.versionId,
    executionId: value.executionId, task: task.value,
    exposure: value.exposure as WorkflowImprovementFeedback["exposure"], quality: value.quality as WorkflowImprovementFeedback["quality"],
    evidenceRefs: [...value.evidenceRefs], followedStepIds: [...value.followedStepIds], explanation: value.explanation,
    ...(comparison === undefined ? {} : { comparison }), ...(userAssessment === undefined ? {} : { userAssessment }),
    ...(processEvidence === undefined ? {} : { processEvidence: processEvidence.value }) } };
}
