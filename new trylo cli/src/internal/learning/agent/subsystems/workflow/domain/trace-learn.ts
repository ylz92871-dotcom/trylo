import { shortId } from "../../../../domains/shared/hash.js";
import type { LearnedWorkflowNode, WorkflowBranch, WorkflowLearningArtifact, WorkflowLearningLedger, WorkflowLearningRequest, WorkflowLearningResult, WorkflowLesson, WorkflowTrace, WorkflowTask } from "./trace-contracts.js";
import { workflowConditionKey, workflowMatches } from "./family.js";
import { correctWorkflowPath, lessonsFromTraces, nodesFromTrace, traceFitsPath, workflowPathKey } from "./trace-paths.js";
import { compareWorkflowUse, effectiveWorkflowTraces, traceHasFailure, workflowStatistics } from "./trace-statistics.js";
import { selectWorkflowPath } from "./trace-select.js";
import { workflowBudgetFits } from "./trace-window.js";
import { renderCheckProvenance, workflowCheckProvenance } from "./trace-correction.js";

export { workflowFamilyKey, workflowMatches } from "./family.js";
export { selectWorkflowPath } from "./trace-select.js";
export { traceStatistics } from "./trace-statistics.js";

type Candidate = { readonly key: string; readonly nodes: readonly LearnedWorkflowNode[]; readonly traces: readonly WorkflowTrace[] };

type ConditionGroup = { readonly when: Readonly<Record<string, string>>; readonly traces: readonly WorkflowTrace[]; readonly candidates: readonly Candidate[] };

type ReadCompatibility = "current" | "legacy_correction";

function conditionGroups(traces: readonly WorkflowTrace[]): readonly ConditionGroup[] {
  const groups = new Map<string, WorkflowTrace[]>();

  for (const trace of traces) {
    const key = workflowConditionKey(trace.conditions);
    groups.set(key, [...(groups.get(key) ?? []), trace]);
  }

  return [...groups.values()].map(group => {
    const candidates = new Map<string, readonly LearnedWorkflowNode[]>();

    for (const trace of group.filter(item => item.outcome === "success")) {
      const nodes = nodesFromTrace(trace);
      candidates.set(workflowPathKey(nodes), nodes);
    }

    return { when: group[0]?.conditions ?? {}, traces: group,
      candidates: [...candidates].map(([key, nodes]) => ({ key, nodes, traces: group.filter(trace => traceFitsPath(trace, nodes)) })) };
  });
}

function branchFor(request: WorkflowLearningRequest, group: ConditionGroup, candidate: Candidate | undefined, compatibility: ReadCompatibility): WorkflowLearningResult<WorkflowBranch> {
  const nodes = candidate?.nodes ?? [];
  const related = candidate?.traces ?? group.traces;
  const lessons: readonly WorkflowLesson[] = [...lessonsFromTraces(related), ...lessonsFromTraces(group.traces.filter(trace => !related.includes(trace))).map(lesson => ({
    afterNode: lesson.afterNode, lesson: `Alternative path experience: ${lesson.lesson}`, evidenceRefs: lesson.evidenceRefs,
  }))];
  const boundedRecovery = lessons.map(lesson => lesson.goto === undefined || nodes.some(node => node.id === lesson.goto)
    ? lesson : { afterNode: lesson.afterNode, lesson: `${lesson.lesson} Unresolved recovery target: ${lesson.goto}.`, evidenceRefs: lesson.evidenceRefs });
  const correctionWhen = request.correction?.when ?? request.conditions ?? {};
  const applies = Object.entries(correctionWhen).every(([key, value]) => group.when[key] === value);
  const hasCorrection = request.correction !== undefined && applies && nodes.some(node => node.id === request.correction?.nodeId);
  const corrected = hasCorrection
    ? correctWorkflowPath(request, nodes, boundedRecovery) : { ok: true as const, value: { nodes, recovery: boundedRecovery } };
  if (!corrected.ok) return corrected;

  const baseEvidenceRefs = (candidate?.traces ?? []).filter(trace => trace.outcome === "success").map(trace => trace.traceId);
  const finalTraces = hasCorrection && compatibility === "current" ? group.traces.filter(trace => traceFitsPath(trace, corrected.value.nodes)
    && trace.steps.some(step => step.nodeId === request.correction?.nodeId && step.check === request.correction?.check)) : candidate?.traces ?? group.traces;
  const provenance = hasCorrection && compatibility === "current" && request.correction !== undefined ? workflowCheckProvenance({
    correction: request.correction, requestId: request.requestId, baseEvidenceRefs, traces: group.traces }) : undefined;

  return { ok: true, value: {
    id: shortId("branch", [workflowConditionKey(group.when), candidate?.key ?? "lessons_only"]), when: group.when,
    mode: nodes.length === 0 ? "lessons_only" : "path", nodes: corrected.value.nodes, recovery: corrected.value.recovery,
    positiveEvidenceRefs: finalTraces.filter(trace => trace.outcome === "success").map(trace => trace.traceId),
    negativeEvidenceRefs: group.traces.filter(traceHasFailure).map(trace => trace.traceId),
    statistics: workflowStatistics(finalTraces),
    ...(provenance === undefined ? {} : { checkProvenance: [provenance] }),
  } };
}

/** Bounded subsystem loop: observe candidates, improve by actual use, stop on stability. */
export function learnWorkflow(request: WorkflowLearningRequest, compatibility: ReadCompatibility = "current"): WorkflowLearningResult<WorkflowLearningArtifact> {
  if (!request.collect) return { ok: false, code: "collection_disabled", message: "collection is disabled; nothing was read or saved" };

  const traces = request.traces;
  const maxRounds = request.budget.maxRounds ?? 4;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 32
    || !workflowBudgetFits(request)) {
    return { ok: false, code: "budget_exhausted", message: "learning exceeds this nomination's episode/step/token/round allowance" };
  }

  if (traces.length === 0 || new Set(traces.map(trace => trace.traceId)).size !== traces.length) {
    return { ok: false, code: "invalid_evidence", message: "at least one uniquely identified trace is required" };
  }

  if (traces.some(trace => !workflowMatches(trace, request))) return { ok: false, code: "task_family_mismatch", message: "scope and every task-family premise must match" };

  const effective = effectiveWorkflowTraces(traces);
  const groups = conditionGroups(effective);
  const choices = groups.map(group => group.candidates.at(-1));
  const changes: { round: number; branchId: string; supportingTraceIds: readonly string[] }[] = [];
  let rounds = 0;
  let examinedCandidates = 0;
  let stopReason: WorkflowLearningLedger["stopReason"] = "round_limit";

  for (let round = 1; round <= maxRounds; round += 1) {
    rounds = round;
    let changed = false;

    for (const [index, group] of groups.entries()) {
      let selected = choices[index];

      if (round > 1) for (const candidate of group.candidates) {
        examinedCandidates += 1;
        const compared = branchFor(request, group, candidate, compatibility);
        if (!compared.ok) return compared;
        const previous = branchFor(request, group, selected, compatibility);
        if (!previous.ok) return previous;
        if (selected === undefined || compareWorkflowUse(compared.value.statistics, previous.value.statistics) < 0) selected = candidate;
      }

      if (round === 1 || selected?.key !== choices[index]?.key) {
        changed = true;
        const branch = branchFor(request, group, selected, compatibility);
        if (!branch.ok) return branch;
        changes.push({ round, branchId: branch.value.id, supportingTraceIds: branch.value.positiveEvidenceRefs });
      }

      choices[index] = selected;
    }

    if (!changed) {
      stopReason = "stable";
      break;
    }
  }

  const branches: WorkflowBranch[] = [];

  for (const [index, group] of groups.entries()) {
    const branch = branchFor(request, group, choices[index], compatibility);
    if (!branch.ok) return branch;
    branches.push(branch.value);
  }

  if (request.correction !== undefined && (request.parentVersionId === undefined
    || !branches.some(branch => Object.entries(request.correction?.when ?? request.conditions ?? {}).every(([key, value]) => branch.when[key] === value)
      && branch.nodes.some(node => node.id === request.correction?.nodeId)))) {
    return { ok: false, code: "invalid_correction", message: "a correction requires a parent and a supported node" };
  }

  const primary = branches.find(branch => branch.mode === "path") ?? branches[0]!;

  return { ok: true, value: { schemaVersion: 2, type: "workflow_learning", requestId: request.requestId,
    scope: request.scope, taskFamily: request.taskFamily, mode: primary.mode, nodes: primary.nodes, recovery: primary.recovery,
    branches, learning: { algorithm: "evidence-cost-v2", maxRounds, rounds, stopReason, processedTraces: effective.length, examinedCandidates,
      supersededTraceIds: traces.filter(trace => !effective.includes(trace)).map(trace => trace.traceId), statisticsScope: "window", changes }, traces,
    positiveEvidenceRefs: [...new Set(branches.flatMap(branch => branch.positiveEvidenceRefs))],
    negativeEvidenceRefs: [...new Set(branches.flatMap(branch => branch.negativeEvidenceRefs))],
    ...(request.conditions === undefined ? {} : { conditions: request.conditions }),
    ...(request.parentVersionId === undefined ? {} : { parentVersionId: request.parentVersionId }),
    ...(request.evidenceWindow === undefined ? {} : { evidenceWindow: request.evidenceWindow }),
    ...(request.correction === undefined ? {} : { correction: request.correction }) } };
}

export function compileWorkflow(artifact: WorkflowLearningArtifact, task: WorkflowTask, maxTokens: number): WorkflowLearningResult<string> {
  const selection = selectWorkflowPath(artifact, task);
  if (!selection.ok) return selection;

  const selected = selection.value.artifact;
  const branch = artifact.branches?.find(item => item.id === selection.value.adoptedBranchId);
  const correction = artifact.correction;
  const correctionApplies = correction !== undefined && Object.entries(correction.when ?? artifact.conditions ?? {})
    .every(([key, value]) => task.conditions?.[key] === value);
  const provenance = correction === undefined || !correctionApplies ? [] : branch?.checkProvenance ?? [workflowCheckProvenance({ correction,
    requestId: artifact.requestId, baseEvidenceRefs: selected.positiveEvidenceRefs,
    traces: effectiveWorkflowTraces(artifact.traces).filter(trace => workflowConditionKey(trace.conditions) === workflowConditionKey(branch?.when ?? artifact.conditions)) })];
  const pathEvidence = provenance.length === 0 ? selected.positiveEvidenceRefs : effectiveWorkflowTraces(artifact.traces)
    .filter(trace => workflowConditionKey(trace.conditions) === workflowConditionKey(branch?.when ?? artifact.conditions)
      && trace.outcome === "success" && traceFitsPath(trace, selected.nodes)).map(trace => trace.traceId);
  const prompt = ["Use this working workflow experience for this task. Current instructions and normal permissions apply.",
    `Workflow request ${selected.requestId}; branch ${selection.value.adoptedBranchId ?? "legacy"}; path evidence: ${pathEvidence.join(", ") || "no complete observation of this changed path yet"}.`,
    ...provenance.map(item => `Original structure evidence: ${item.baseEvidenceRefs.join(", ")}. ${renderCheckProvenance(item)}`),
    ...(provenance.length > 0 && branch?.checkProvenance === undefined ? ["Legacy cost figures describe the original recipe, not measurements of the changed check."] : []),
    "Run each node's exact check command using run_shell, then immediately call workflow_record_step with nodeId and actual input/output references. Omit checkToolCallId: runtime binds the unique fresh exact check. Historical tool IDs and evidence refs cannot be reused. If needed workflow_progress.availableChecks shows only safe current checker IDs.",
    "Consume the actual upstream output references shown by workflow_progress. This local progress read preserves the fresh check; other tools invalidate it. Observe dependencies. On failure record it and follow the stated recovery with fresh checks.",
    ...selected.nodes.map(node => JSON.stringify(node)), "Failure lessons and recovery (first match takes precedence):",
    ...selected.recovery.map(lesson => JSON.stringify(lesson))].join("\n");

  return Number.isSafeInteger(maxTokens) && maxTokens > 0 && Math.ceil(prompt.length / 4) <= maxTokens
    ? { ok: true, value: prompt } : { ok: false, code: "dispatch_budget_exhausted", message: "compiled workflow exceeds dispatch allowance" };
}
