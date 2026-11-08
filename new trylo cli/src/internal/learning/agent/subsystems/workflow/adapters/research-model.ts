import { emptyUsage, mergeUsage, type ProviderPort } from "../../../../../ports/provider.js";
import { fields, list, text } from "../../../../../validation/json-shape.js";
import type { WorkflowImprovement, WorkflowImprovementModelInput, WorkflowImprovementResearchAction, WorkflowImprovementResearchInput } from "../improvement/contracts.js";
import type { WorkflowResearchObservation, WorkflowResearchUsage } from "../improvement/research-contracts.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { workflowFailure } from "../domain/trace-parse.js";
import { parseWorkflowImprovementResponse, workflowImprovementEditScope } from "../improvement/scoped-edit.js";
import { WORKFLOW_IMPROVEMENT_LIMITS } from "../runtime/improvement-contracts.js";
import { workflowImprovementPrompt } from "./improvement-prompt.js";
import { nextWorkflowImprovementEvent } from "./improvement-stream.js";
import { parseWorkflowResearchFinding } from "../improvement/research-finding.js";

export type WorkflowResearchModelOptions = {
  readonly provider: ProviderPort;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly maxPromptChars?: number;
  /** Actual provider or explicitly configured host generation allowance. */
  readonly maxOutputTokens?: number;
};

type Projection = { readonly instruction: string; readonly prompt: string; readonly reservedInput: number; readonly maxOutputTokens: number };

const noUsage = (): WorkflowResearchUsage => ({ calls: 0, tokens: 0, observedTokens: 0, uncertain: false });
const refs = (value: unknown, maximum: number, minimum = 1): value is readonly string[] =>
  list(value, minimum, maximum) && value.every(item => text(item, 4096)) && new Set(value).size === value.length;
const failure = (message: string) => workflowFailure("invalid_workflow_research_action", message);

/** The caller owns reservation and durable checkpoints. This port sends at most once. */
export function createWorkflowResearchModel(options: WorkflowResearchModelOptions) {
  let usage = noUsage(), active = false, attempt = 0;
  return {
    usage: () => ({ ...usage }),
    async research(context: WorkflowImprovementResearchInput, signal: AbortSignal, allowance: number): Promise<WorkflowLearningResult<WorkflowImprovementResearchAction>> {
      if (active) return workflowFailure("workflow_research_busy", "A research model call is already in flight");

      usage = noUsage();
      const projected = workflowResearchPrompt(context, allowance, options.maxPromptChars, options.maxOutputTokens);
      if (!projected.ok) return projected;

      active = true;

      try {
        const response = await readWorkflowResearchStream(options, projected.value, signal, allowance, `workflow-research:${++attempt}`);

        usage = response.usage;

        if (!response.result.ok) return response.result;

        let raw: unknown;

        try { raw = JSON.parse(response.result.value); }
        catch { return workflowFailure("learning_invalid_json", "Workflow researcher did not return a JSON action"); }

        return parseAction(raw, context, projected.value);
      } finally { active = false; }
    },
  };
}

function observationValid(value: unknown): value is WorkflowResearchObservation {
  return fields(value, ["kind", "evidenceRefs"]) && value.kind === "material_read" && refs(value.evidenceRefs, 8)
    || fields(value, ["kind", "versionIds"]) && value.kind === "versions_compared" && refs(value.versionIds, 4)
    || fields(value, ["kind", "finding"]) && value.kind === "finding_recorded" && parseWorkflowResearchFinding(value.finding).ok
    || fields(value, ["kind", "code", "message"]) && value.kind === "invalid_response" && text(value.code, 1500) && text(value.message, 1500);
}

/** Whole entries only: an abbreviated directory is not exposure to source facts. */
function boundedIndex<T>(items: readonly T[], maximumItems: number, maximumChars: number) {
  const included: T[] = [];
  for (const item of items) {
    if (included.length >= maximumItems) break;
    if (JSON.stringify([...included, item]).length <= maximumChars) included.push(item);
  }
  return { entries: included, omitted: items.length - included.length };
}

function versionMaterial(artifact: WorkflowImprovement, context: WorkflowImprovementModelInput) {
  const targets = context.opportunity.affectedStepIds;
  if (targets === undefined) return { diagnosis: artifact.proposal.diagnosis, procedure: artifact.proposal.procedure, changes: artifact.proposal.changes };

  const scope = workflowImprovementEditScope(artifact, targets);

  return !scope.ok ? { unavailableReason: scope.code } : { diagnosis: artifact.proposal.diagnosis, changes: artifact.proposal.changes,
    procedure: { ...artifact.proposal.procedure, steps: undefined, editableSteps: scope.value,
      stepsOutline: artifact.proposal.procedure.steps.map(step => ({ id: step.id, dependsOn: step.dependsOn,
        actionExcerpt: step.action.slice(0, 96), actionAbbreviated: step.action.length > 96 })) } };
}

export function workflowResearchPrompt(context: WorkflowImprovementResearchInput, allowance: number, promptLimit?: number, hostMaxOutputTokens?: number) {
  if (!Array.isArray(context.observations) || context.observations.length > 64 || !context.observations.every(observationValid)) {
    return workflowFailure("invalid_workflow_research_observations", "Research requires bounded, confirmed material/comparison/validation receipts");
  }

  const observations: readonly WorkflowResearchObservation[] = context.observations;
  const materialRefs = [...observations].reverse().find(item => item.kind === "material_read")?.evidenceRefs ?? [];
  const versionIds = [...observations].reverse().find(item => item.kind === "versions_compared")?.versionIds ?? [];
  const versions = context.history ?? [];
  if (materialRefs.some(ref => !context.evidence.some(item => item.ref === ref)) || versionIds.some(id => !versions.some(item => item.versionId === id))) {
    return workflowFailure("workflow_research_material_unavailable", "A prior research receipt no longer resolves in the current source context");
  }

  const evidence = context.evidence.filter(item => materialRefs.includes(item.ref));
  const projected = workflowImprovementPrompt({ ...context, evidence, history: [],
    feedback: context.feedback.filter(item => materialRefs.includes(item.feedbackId)) }, allowance, promptLimit, hostMaxOutputTokens);
  if (!projected.ok) return projected;

  const nominated = new Set(context.opportunity.evidenceRefs);
  const ordered = [...context.evidence.filter(item => nominated.has(item.ref)), ...context.evidence.filter(item => !nominated.has(item.ref))];
  const materials = boundedIndex(ordered.map(item => ({ ref: item.ref, kind: item.kind,
    summaryExcerpt: item.summary.slice(0, 96), abbreviated: item.summary.length > 96 })), 64, 6000);
  const versionIndex = boundedIndex(versions.slice(-8).map(item => ({ versionId: item.versionId,
    issueKey: item.artifact.opportunity.issueKey, nameExcerpt: item.artifact.proposal.procedure.name.slice(0, 96) })), 8, 2000);
  const comparedVersions = versions.filter(item => versionIds.includes(item.versionId)).map(item => ({
    versionId: item.versionId, ...versionMaterial(item.artifact, context) }));
  const visibleVersionIds = comparedVersions.filter(item => !("unavailableReason" in item)).map(item => item.versionId);
  const findings = observations.flatMap(item => item.kind === "finding_recorded" ? [item.finding] : []);
  const recentFindings = findings.slice(-8).map(finding => ({ finding,
    standing: "working_understanding_recheck_current_conditions_not_new_external_evidence",
    sourceStatus: finding.sourceRefs.map(ref => ({ ref,
      resolvedInCurrentContext: context.evidence.some(item => item.ref === ref) || versions.some(item => item.versionId === ref),
      exposedInThisCall: projected.value.visibleEvidenceRefs.includes(ref) || visibleVersionIds.includes(ref) })) }));
  const instruction = projected.value.instruction + "\n" + [
    "You are in a resumable internal research session. Return exactly ONE action object instead of the bare proposal schema above.",
    "Actions: {kind:'read_material',evidenceRefs:[1..8 directory refs]}, {kind:'compare_versions',versionIds:[1..4 directory version IDs]}, {kind:'record_finding',finding:{kind:'hypothesis'|'interpretation'|'counterexample'|'open_question',statement,conditions,sourceRefs:[1..8 refs],nextQuestion?}}, {kind:'propose',proposal:PROPOSAL_OR_LOCAL_PATCH}, {kind:'wait_for_evidence',reason,evidenceRefs:[0..8 directory refs]}, {kind:'stop',reason}. Reasons/statements have at most 1500 characters; finding conditions/nextQuestion at most 1000. No extra fields.",
    "PROPOSAL_OR_LOCAL_PATCH follows the original full/local schema above. Preserve that edit scope and every parent quality invariant. Reading/comparing cannot expand the local rewrite scope.",
    "Directories and confirmed prior research receipts are navigation only. Cite only evidence objects actually present in currentMaterial.evidence, never a directory excerpt or an earlier unexposed read. Requests do not attest execution, quality, permission or new facts.",
    "Only the most recent confirmed material_read and versions_compared selection is expanded in this call. Request a different bounded set if needed. A version comparison is historical proposal context, not outcome evidence.",
    "record_finding saves public working understanding or a remaining question when useful; you need not record one every step. Cite only currently exposed evidence refs or fully exposed compared version IDs. Read unexposed sources first. A counterexample finding is an interpretation of its cited facts, not an invented external observation.",
    "recentFindings retains the latest eight findings with original conditions, source refs and optional next questions across material/context changes. Recheck their conditions against this context. Unresolved or unexposed historical sources are pointers only; findings do not resolve those sources, create new evidence, strengthen support, or qualify as proposal evidence refs. Re-read actual source facts before relying on them for a new proposal.",
    "Use invalid_response receipts to correct a malformed action or proposal on a later funded call. Do not invent absent evidence or send an unsupported proposal just to complete the session.",
  ].join("\n");
  const prompt = JSON.stringify({ currentMaterial: JSON.parse(projected.value.prompt), materialIndex: materials,
    versionIndex, comparedVersions, recentFindings, omittedFindings: findings.length - recentFindings.length,
    observations: observations.filter(item => item.kind !== "finding_recorded") });
  const maxPromptChars = promptLimit ?? WORKFLOW_IMPROVEMENT_LIMITS.maxPromptChars;
  const reservedInput = new TextEncoder().encode(instruction + prompt).length + 512;
  const availableOutput = allowance - reservedInput;
  const maxOutputTokens = hostMaxOutputTokens === undefined ? availableOutput : Math.min(hostMaxOutputTokens, availableOutput);
  if (!Number.isSafeInteger(maxPromptChars) || !Number.isSafeInteger(allowance) || instruction.length + prompt.length > maxPromptChars
    || maxOutputTokens < WORKFLOW_IMPROVEMENT_LIMITS.minProposalOutputTokens) return workflowFailure("learning_budget_exhausted", "Selected research material, directory and a complete action do not fit this call allowance");

  return { ok: true as const, value: { instruction, prompt, reservedInput, maxOutputTokens,
    visibleEvidenceRefs: projected.value.visibleEvidenceRefs, visibleVersionIds, materialRefs: materials.entries.map(item => item.ref),
    versionIds: versionIndex.entries.map(item => item.versionId) } };
}

function parseAction(raw: unknown, context: WorkflowImprovementResearchInput,
  visible: { readonly visibleEvidenceRefs: readonly string[]; readonly visibleVersionIds: readonly string[];
    readonly materialRefs: readonly string[]; readonly versionIds: readonly string[] }): WorkflowLearningResult<WorkflowImprovementResearchAction> {
  if (fields(raw, ["kind", "evidenceRefs"]) && raw.kind === "read_material" && refs(raw.evidenceRefs, 8)) {
    return raw.evidenceRefs.every(ref => visible.materialRefs.includes(ref)) ? { ok: true, value: { kind: raw.kind, evidenceRefs: [...raw.evidenceRefs] } }
      : failure("Material requests must name current directory refs");
  }

  if (fields(raw, ["kind", "versionIds"]) && raw.kind === "compare_versions" && refs(raw.versionIds, 4)) {
    return raw.versionIds.every(id => visible.versionIds.includes(id)) ? { ok: true, value: { kind: raw.kind, versionIds: [...raw.versionIds] } }
      : failure("Version comparisons must name current directory versions");
  }

  if (fields(raw, ["kind", "finding"]) && raw.kind === "record_finding") {
    const finding = parseWorkflowResearchFinding(raw.finding);
    if (!finding.ok) return finding;
    return finding.value.sourceRefs.every(ref => visible.visibleEvidenceRefs.includes(ref) || visible.visibleVersionIds.includes(ref))
      ? { ok: true, value: { kind: raw.kind, finding: finding.value } }
      : workflowFailure("improvement_evidence_unexposed", "A working finding must cite facts or compared versions actually exposed in this research call");
  }

  if (fields(raw, ["kind", "reason", "evidenceRefs"]) && raw.kind === "wait_for_evidence" && text(raw.reason, 1500) && refs(raw.evidenceRefs, 8, 0)) {
    return raw.evidenceRefs.every(ref => visible.materialRefs.includes(ref)) ? { ok: true,
      value: { kind: raw.kind, reason: raw.reason, evidenceRefs: [...raw.evidenceRefs] } } : failure("Waiting refs must name current source facts");
  }

  if (fields(raw, ["kind", "reason"]) && raw.kind === "stop" && text(raw.reason, 1500)) return { ok: true, value: { kind: raw.kind, reason: raw.reason } };

  if (!fields(raw, ["kind", "proposal"]) || raw.kind !== "propose") return failure("Return one bounded research action with its exact fields");

  const parsed = parseWorkflowImprovementResponse(raw.proposal, context.parent, context.opportunity.affectedStepIds);
  if (!parsed.ok) return parsed;

  const cited = [...parsed.value.diagnosis.supportingRefs, ...parsed.value.diagnosis.counterEvidenceRefs, ...parsed.value.changes.flatMap(change => change.evidenceRefs)];

  return cited.every(ref => visible.visibleEvidenceRefs.includes(ref)) ? { ok: true, value: { kind: "propose", proposal: parsed.value } }
    : workflowFailure("improvement_evidence_unexposed", "The proposal cites facts absent from this research call's material exposure");
}

/** Shared proposal/research transport. Its receipt is per-call even after a prior unknown outcome. */
export async function readWorkflowResearchStream(input: WorkflowResearchModelOptions, projected: Projection,
  signal: AbortSignal, allowance: number, attemptId: string): Promise<{ readonly result: WorkflowLearningResult<string>; readonly usage: WorkflowResearchUsage }> {
  if (signal.aborted) return { result: workflowFailure("cancelled", "Workflow research cancelled before sending"), usage: noUsage() };

  const { instruction, prompt, reservedInput, maxOutputTokens } = projected;
  let usage = emptyUsage(), output = "", finished = false, complete = false, drained = false, usageIncomplete = false;
  const controller = new AbortController(), abort = () => controller.abort();

  signal.addEventListener("abort", abort, { once: true });

  if (signal.aborted) controller.abort();

  const timer = input.timeoutMs === undefined ? undefined : setTimeout(abort, input.timeoutMs);
  let result: WorkflowLearningResult<string>;

  try {
    const iterator = input.provider.stream({ attemptId, model: input.model,
      messages: [{ role: "system", content: instruction }, { role: "user", content: prompt }], tools: [], maxOutputTokens,
      ...(input.provider.responseFormats?.includes("json_object") ? { responseFormat: { type: "json_object" as const } } : {}) }, controller.signal)[Symbol.asyncIterator]();

    result = await collect();

    async function collect(): Promise<WorkflowLearningResult<string>> {
      while (true) {
        const next = await nextWorkflowImprovementEvent(iterator, controller.signal);
        if (next === "aborted" || controller.signal.aborted) return workflowFailure(signal.aborted ? "cancelled" : "learning_timeout", "Workflow research ended before its complete result");

        if (next.done) break;

        const event = next.value;
        if (event.type === "usage") usage = mergeUsage(usage, event.usage);

        if (event.type === "warning" && event.code === "stream_finish_tail_timeout") usageIncomplete = true;

        if (finished && event.type !== "usage" && event.type !== "warning") return workflowFailure("learning_post_finish_event", "Workflow research changed after finish");

        if (event.type === "text_delta") output += event.text;

        if (event.type.startsWith("tool_")) return workflowFailure("learning_tool_forbidden", "Workflow researcher cannot execute tools");

        if (event.type === "error") return workflowFailure(`learning_provider_${event.class}`, "Workflow research provider failed");

        if (event.type === "finish") {
          // A length boundary rejects the action, but its usage tail still
          // belongs to this original request and must be drained and charged.
          finished = true;
          complete = event.reason === "stop" && !event.requiresFollowUp;
        }
      }

      drained = true;

      if (!finished || !complete) return workflowFailure("learning_incomplete", "Workflow provider ended without a complete research action");

      if (usage.totalTokens > allowance) return workflowFailure("learning_budget_exhausted", "Provider usage exceeded its reservation");

      return { ok: true, value: output };
    }
  } catch {
    result = workflowFailure(signal.aborted ? "cancelled" : controller.signal.aborted ? "learning_timeout" : "learning_provider_unavailable", "Workflow research provider was unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }

  const known = finished && drained && !controller.signal.aborted && !usageIncomplete && usage.totalTokens > 0;

  controller.abort();

  return { result, usage: { calls: 1, tokens: known ? usage.totalTokens : Math.max(usage.totalTokens, reservedInput + maxOutputTokens),
    observedTokens: usage.totalTokens, uncertain: !known } };
}
