import type { WorkflowTask } from "../domain/trace-contracts.js";
import { workflowMatches } from "../domain/family.js";
import type { WorkflowVersion } from "./archive.js";
import type { ExplicitWorkflowCorrection } from "./recommendation.js";
import type { WorkflowImprovementEvidence, WorkflowProcessTask } from "../improvement/contracts.js";
import type { WorkflowAssetVisibility } from "./asset-visibility.js";
import type { WorkflowImprovementDispatchDecision } from "./improvement-contracts.js";
import { WORKFLOW_IMPROVEMENT_LIMITS } from "./improvement-contracts.js";

export type LegacyWorkflowContext = {
  readonly hostTask?: WorkflowTask;
  readonly corrections: readonly ExplicitWorkflowCorrection[];
  readonly reference?: WorkflowVersion;
} & ({ readonly kind: "reference" } | { readonly kind: "pinned"; readonly versionId: string }
  | { readonly kind: "unavailable"; readonly reason: string });

function applicable(context: LegacyWorkflowContext) {
  const effective = context.corrections.filter(item => item.visibility === undefined || item.visibility === "available");
  const unknownSources = context.corrections.filter(item => item.visibility === "unknown"
    && (context.hostTask === undefined || workflowMatches(item.task, context.hostTask)));

  if (context.hostTask === undefined) return { constraints: [] as readonly ExplicitWorkflowCorrection[],
    unresolved: effective, unknown: effective.length > 0 || unknownSources.length > 0, sourceUnknown: unknownSources.length > 0,
    sourceRefs: [...effective, ...unknownSources].map(item => item.sourceVersionId) };

  const possible = effective.filter(item => workflowMatches(item.task, context.hostTask!));
  const missing = possible.filter(item => Object.keys(item.correction.when ?? {}).some(key => context.hostTask!.conditions?.[key] === undefined));
  const constraints = new Map<string, ExplicitWorkflowCorrection>();

  for (const item of possible) {
    if (Object.entries(item.correction.when ?? {}).every(([key, value]) => context.hostTask!.conditions?.[key] === value)) constraints.set(item.correction.nodeId, item);
  }

  return { constraints: [...constraints.values()], unresolved: missing, unknown: missing.length > 0 || unknownSources.length > 0,
    sourceUnknown: unknownSources.length > 0,
    sourceRefs: [...(missing.length > 0 ? missing : [...constraints.values()]), ...unknownSources].map(item => item.sourceVersionId) };
}

/** History can change; source-bound explicit user corrections remain separate constraints. */
export function legacyWorkflowGuidance(context: LegacyWorkflowContext) {
  const selected = applicable(context);
  const constraintText = selected.constraints.map(item => JSON.stringify({ sourceVersionId: item.sourceVersionId,
    taskFamily: item.task.taskFamily, when: item.correction.when ?? {}, nodeId: item.correction.nodeId,
    exactCheck: item.correction.check, recoveryTo: item.correction.recoveryTo }));
  const guidance = constraintText.length === 0 ? "" : [
    "Persistent explicit workflow corrections from the host's frozen task context:",
    ...constraintText,
    "Retain each applicable exact check and recovery requirement at its matching artifact checkpoint. These are user intent constraints, never tool permissions. Current user instructions still govern. A model-supplied task label or omitted condition cannot deactivate them.",
  ].join("\n");
  const sourceRefs = selected.sourceRefs;
  const unresolved = selected.unresolved;
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  const tooLarge = bytes(guidance) > WORKFLOW_IMPROVEMENT_LIMITS.maxDispatchTokens;
  const reference = context.reference !== undefined && (context.reference.visibility === undefined || context.reference.visibility === "available")
    ? context.reference : undefined;
  const referenceText = context.kind === "unavailable" ? `Historical workflow governance is unavailable (${context.reason}). Continue ordinary work; a new learned procedure cannot be adopted until saved constraints are known.`
    : context.kind === "pinned" ? `The existing workflow instance ${context.versionId} remains pinned. Learn in the background for a later task; do not layer a new procedure onto this instance.`
    : reference === undefined ? "" : [
      `Optimizable historical workflow reference ${reference.versionId}; it is not a frozen execution graph for this new task.`,
      "Its operation sequence, probing, reuse, branches and verification timing may be improved. Only separately listed explicit user corrections remain mandatory.",
      JSON.stringify({ taskFamily: reference.artifact.taskFamily, mode: reference.artifact.mode,
        exampleNodes: reference.artifact.nodes.slice(0, 4).map(node => ({ id: node.id, input: node.input, output: node.output })),
        historicalLessons: reference.artifact.recovery.slice(0, 3),
        omittedNodes: Math.max(0, reference.artifact.nodes.length - 4), omittedLessons: Math.max(0, reference.artifact.recovery.length - 3) }),
    ].join("\n");
  const note = selected.sourceUnknown ? "A saved explicit correction has unavailable owning metadata or provenance. Its contents are withheld; new workflow adoption is deferred while ordinary work continues."
    : selected.unknown ? `Saved corrections have unresolved applicability in the host task; new workflow adoption is deferred until premises are established. Conditional sources: ${JSON.stringify(unresolved.map(item => ({ sourceVersionId: item.sourceVersionId, taskFamily: item.task.taskFamily, when: item.correction.when ?? {} })))}.` : "";
  const withdrawn = context.corrections.some(item => item.visibility === "blocked" || item.visibility === "forgotten")
    ? "Withdrawn historical correction sources have no effective authority. Their contents are omitted and older equivalent corrections are not restored." : "";
  const prompt = [bytes(referenceText) <= 2048 ? referenceText : reference === undefined ? "" : `Historical reference ${reference.versionId} is available for inspection; its example graph exceeds the reference budget.`,
    tooLarge ? `Saved exact corrections exceed this dispatch budget; inspect sources ${JSON.stringify(sourceRefs)} before claiming compatibility.` : guidance, note, withdrawn].filter(Boolean).join("\n");
  const evidence: WorkflowImprovementEvidence[] = selected.constraints.map(item => ({ ref: `legacy-correction:${item.sourceVersionId}`,
    kind: "user_correction", sourceVersionId: item.sourceVersionId,
    summary: `Previously recorded explicit user workflow correction, not a new execution: ${JSON.stringify({ task: item.task,
      when: item.correction.when ?? {}, nodeId: item.correction.nodeId, exactCheck: item.correction.check, recoveryTo: item.correction.recoveryTo })}` }));

  evidence.push(...unresolved.map(item => ({ ref: `legacy-conditional-correction:${item.sourceVersionId}`, kind: "context" as const,
    sourceVersionId: item.sourceVersionId,
    summary: `Conditional explicit user correction with unknown current applicability; do not assume it inactive: ${JSON.stringify({ task: item.task,
      when: item.correction.when ?? {}, nodeId: item.correction.nodeId, exactCheck: item.correction.check, recoveryTo: item.correction.recoveryTo })}` })));
  const requiredSources = [...new Set([...selected.constraints, ...unresolved].map(item => item.sourceVersionId)
    .concat(reference === undefined ? [] : [reference.versionId]))];

  return { prompt, evidence,
    dispatchPolicy(_task?: WorkflowProcessTask, sourceVisibility?: Readonly<Record<string, WorkflowAssetVisibility>>): { readonly ok: true; readonly value: WorkflowImprovementDispatchDecision } {
      if (context.kind === "reference" && requiredSources.some(id => sourceVisibility?.[id] !== "available")) {
        return { ok: true, value: { kind: "deferred", reason: "legacy_workflow_source_revoked",
          sourceRefs: requiredSources.filter(id => sourceVisibility?.[id] !== "forgotten") } };
      }
      return { ok: true, value: context.kind === "unavailable" ? { kind: "deferred", reason: context.reason, sourceRefs }
        : context.kind === "pinned" ? { kind: "deferred", reason: "legacy_workflow_pinned", sourceRefs,
        pinnedVersionId: context.versionId } : selected.unknown ? { kind: "deferred", reason: selected.sourceUnknown ? "legacy_workflow_source_unknown" : "legacy_workflow_premises_unknown", sourceRefs }
        : tooLarge ? { kind: "deferred", reason: "legacy_workflow_constraints_budget", sourceRefs }
          : { kind: "allowed", ...(guidance.length === 0 ? {} : { guidance }) } };
    } };
}
