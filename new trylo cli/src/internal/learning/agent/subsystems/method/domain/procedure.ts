import { canonicalObservations, MAX_OBSERVATION_ID_CHARS, type MethodObservation } from "./inference-observations.js";

/** Model-readable residual practice, never executable tool code or a permission grant. */
export type CompiledProcedure = {
  readonly schemaVersion: 1;
  readonly steps: readonly {
    readonly id: string;
    readonly when: string;
    readonly action: string;
    readonly expect: string;
    readonly onMismatch: "block";
  }[];
  readonly eliminatedDecisions: readonly {
    readonly decision: string;
    readonly resolution: string;
    /** Semantic justification by the compiler, not an observed success or a proof. */
    readonly basis: string;
    readonly evidenceIds: readonly string[];
  }[];
};

export const MAX_PROCEDURE_RENDER_CHARS = 700;

export type ProcedureExecutionContent = {
  readonly compact: { readonly when: string; readonly action: string; readonly exceptions: string };
  readonly procedure?: CompiledProcedure;
};

/** Mechanical no-op identity, not semantic equivalence. Explanations, evidence
 * references and renamed step ids cannot create a new execution policy.
 * Natural-language paraphrases remain a responsibility of semantic review. */
export function procedureExecutionKey(content: ProcedureExecutionContent): string {
  const normalize = (value: string) => value.trim().replace(/\s+/gu, " ");
  return JSON.stringify({ when: normalize(content.compact.when), exceptions: normalize(content.compact.exceptions),
    practice: content.procedure === undefined ? normalize(content.compact.action) : content.procedure.steps.map(step =>
      [normalize(step.when), normalize(step.action), normalize(step.expect), step.onMismatch]) });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Closed, small and linear, with no executable control-flow edges. Semantic
 * fidelity of the action text remains the compiler's explicit judgment. */
export function isCompiledProcedure(value: unknown): value is CompiledProcedure {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "steps", "eliminatedDecisions"]) || value.schemaVersion !== 1 ||
    !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 4 ||
    !Array.isArray(value.eliminatedDecisions) || value.eliminatedDecisions.length < 1 || value.eliminatedDecisions.length > 3) return false;

  const ids = new Set<string>();

  for (const step of value.steps) {
    if (!record(step) || !exactKeys(step, ["id", "when", "action", "expect", "onMismatch"]) ||
      typeof step.id !== "string" || !/^[a-z][a-z0-9_-]{0,23}$/.test(step.id) || ids.has(step.id) ||
      !text(step.when, 120) || !text(step.action, 200) || !text(step.expect, 140) || step.onMismatch !== "block") return false;
    ids.add(step.id);
  }

  for (const choice of value.eliminatedDecisions) {
    if (!record(choice) || !exactKeys(choice, ["decision", "resolution", "basis", "evidenceIds"]) ||
      !text(choice.decision, 160) || !text(choice.resolution, 200) || !text(choice.basis, 400) ||
      !Array.isArray(choice.evidenceIds) || choice.evidenceIds.length < 1 || choice.evidenceIds.length > 8 ||
      !choice.evidenceIds.every(id => text(id, MAX_OBSERVATION_ID_CHARS)) || new Set(choice.evidenceIds).size !== choice.evidenceIds.length) return false;
  }

  return renderCompiledProcedure(value as CompiledProcedure).length <= MAX_PROCEDURE_RENDER_CHARS;
}

/** Call with the actual supplied source observations, never the whole library.
 * Identity and outcome checks are enforceable; basis/fidelity remain the model's
 * semantic judgment. A named observation alone does not prove specialization. */
export function procedureEvidenceError(procedure: CompiledProcedure, observations: readonly MethodObservation[]): string | undefined {
  if (!isCompiledProcedure(procedure)) return "invalid_method_procedure";

  const available = new Map(canonicalObservations(observations).map(item => [item.observationId, item]));

  for (const choice of procedure.eliminatedDecisions) {
    for (const id of choice.evidenceIds) {
      const observation = available.get(id);
      if (observation === undefined || observation.compilationId !== undefined ||
        observation.adoption !== "adopted" || observation.outcome !== "helped") {
        return "procedure_source_evidence_unavailable";
      }
    }
  }

  return undefined;
}

/** Centralizes all model text for the existing forbidden-content admission scan. */
export function procedureTextFields(procedure: CompiledProcedure): readonly string[] {
  return [...procedure.steps.flatMap(step => [step.id, step.when, step.action, step.expect]),
    ...procedure.eliminatedDecisions.flatMap(choice => [choice.decision, choice.resolution, choice.basis])];
}

/** Only the residual practice enters normal planning; compilation rationale and
 * evidence stay in its immutable review and can be expanded when needed. */
export function renderCompiledProcedure(procedure: CompiledProcedure): string {
  return procedure.steps.map(step => `[${step.id}] When: ${step.when}; Do: ${step.action}; Check: ${step.expect}`).join("\n") +
    "\nIf any condition/check is unmet or unknown: stop this procedure, report block with the step id and observed facts, then resume normal analysis.";
}
