import type { MethodExperienceFact } from "./experience-facts.js";
import type { ExperienceExposureBinding } from "./exposure-binding.js";
import { canonicalCardJson } from "./contracts.js";

/** Observed execution during an adopted, delivered binding. Association is not
 * causal attribution and tool success is never a helpfulness observation. */
export type MethodExecutionTrace = {
  readonly exposureId: string;
  readonly taskId: string;
  readonly opportunityId: string;
  readonly scopeId: string;
  readonly compilationId?: string;
  readonly beat: number;
  /** Absent only on historical traces collected before request freshness. */
  readonly firstSequence?: number;
  readonly lastSequence?: number;
  readonly succeededTools: readonly string[];
  readonly failures: readonly { readonly tool: string; readonly code: string; readonly fingerprint: string }[];
  readonly omitted: number;
};

export const MAX_TRACE_TOOLS = 8;
const MAX_SPAN_TOOL_NAMES = 64;

export type MethodExecutionSpan = { readonly firstSequence: number; readonly lastSequence: number;
  readonly toolNames: readonly string[] };

export function isMethodExecutionSpan(value: unknown): value is MethodExecutionSpan {
  return record(value) && Object.keys(value).length === 3 && nonnegativeInteger(value.firstSequence) &&
    nonnegativeInteger(value.lastSequence) && value.lastSequence >= value.firstSequence &&
    Array.isArray(value.toolNames) && value.toolNames.length > 0 && value.toolNames.length <= MAX_SPAN_TOOL_NAMES &&
    value.toolNames.every(item => text(item, 200)) && new Set(value.toolNames).size === value.toolNames.length;
}

/** One causal association policy for the collector and persisted trace guard. */
export function executionAdoptionFor(facts: readonly MethodExperienceFact[], exposure: {
  readonly versionId: string; readonly scope: string; readonly useSequence?: number; readonly binding?: ExperienceExposureBinding;
}, beforeSequence: number): Extract<MethodExperienceFact, { kind: "decision" }> | undefined {
  const binding = exposure.binding, sequence = exposure.useSequence;
  if (binding === undefined || sequence === undefined) return undefined;

  const decisions = facts.filter((fact): fact is Extract<MethodExperienceFact, { kind: "decision" }> => fact.kind === "decision" &&
    fact.versionId === exposure.versionId && fact.sequence < beforeSequence && fact.context.taskId === binding.context.taskId &&
    fact.context.opportunityId === binding.context.opportunityId);
  const sameBinding = (fact: typeof decisions[number]) => fact.decision.action === "adopt" && fact.decision.scopeId === exposure.scope &&
    fact.decision.compilationId === binding.compilationId && canonicalCardJson(fact.context) === canonicalCardJson(binding.context);
  if (decisions.some(fact => fact.sequence > sequence && !sameBinding(fact))) return undefined;

  const prior = [...decisions].reverse().find(fact => fact.sequence < sequence);

  return prior !== undefined && sameBinding(prior) ? prior : undefined;
}

export function isMethodExecutionTrace(value: unknown): value is MethodExecutionTrace {
  if (!record(value)) return false;
  return Object.keys(value).every(key => ["exposureId", "taskId", "opportunityId", "scopeId", "compilationId", "beat",
    "firstSequence", "lastSequence", "succeededTools", "failures", "omitted"].includes(key)) &&
    [value.exposureId, value.taskId, value.opportunityId, value.scopeId].every(item => text(item, 200)) &&
    (value.compilationId === undefined || text(value.compilationId, 200)) &&
    positiveInteger(value.beat) && nonnegativeInteger(value.omitted) &&
    (value.firstSequence === undefined && value.lastSequence === undefined ||
      nonnegativeInteger(value.firstSequence) && nonnegativeInteger(value.lastSequence) && value.lastSequence >= value.firstSequence) &&
    Array.isArray(value.succeededTools) && value.succeededTools.length <= MAX_TRACE_TOOLS &&
    value.succeededTools.every(item => text(item, 200)) &&
    Array.isArray(value.failures) && value.failures.length <= MAX_TRACE_TOOLS && value.failures.every(item =>
      record(item) && Object.keys(item).every(key => ["tool", "code", "fingerprint"].includes(key)) &&
      [item.tool, item.code, item.fingerprint].every(part => text(part, 200))) &&
    value.succeededTools.length + value.failures.length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, cap: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= cap;
}

function nonnegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && typeof value === "number" && value >= 0; }

function positiveInteger(value: unknown): value is number { return nonnegativeInteger(value) && value > 0; }
