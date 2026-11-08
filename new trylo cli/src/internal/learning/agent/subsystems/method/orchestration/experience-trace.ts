import { shortId } from "../../../../domains/shared/hash.js";
import { canonicalCardJson } from "../domain/contracts.js";
import { executionAdoptionFor, isMethodExecutionSpan, MAX_TRACE_TOOLS } from "../domain/execution-trace.js";
import { METHOD_CONTEXT_TOOL, type ExperienceContext } from "../experience-port.js";
import type { MethodBeatReport } from "../port.js";
import type { ExperienceRuntimeOptions } from "./experience-runtime.js";

/** The planning exposure freezes context before this beat's tool calls. A
 * context/adopt call inside the beat cannot retrospectively claim its tools. */
export async function recordExecutionTrace(options: ExperienceRuntimeOptions, report: MethodBeatReport,
  settled: { readonly context: ExperienceContext; readonly selections: readonly {
    readonly versionId: string; readonly scopeId: string; readonly compilationId?: string }[];
    readonly requestBoundarySequence?: number } | undefined): Promise<void> {
  // Tool-order evidence is unavailable at this seam. A context may change
  // A→B→A inside one beat, so equality at settlement cannot restore attribution.
  const span = report.executionSpan;
  if (!isMethodExecutionSpan(span) || settled?.requestBoundarySequence === undefined ||
    span.toolNames.includes(METHOD_CONTEXT_TOOL) || span.firstSequence <= settled.requestBoundarySequence) return;

  const succeeded = report.succeededTools;
  const failed = report.failures;
  if (succeeded.length + failed.length === 0) return;

  const view = await options.store.load();

  for (const fielding of view.fieldings ?? []) {
    if (fielding.turnId !== report.turnId || fielding.beat !== report.beat || fielding.binding === undefined ||
      fielding.exposureId === undefined || fielding.useSequence === undefined) continue;

    const binding = fielding.binding;

    // Without tool-order evidence, a context switch/block during this beat
    // makes association ambiguous. Do not relabel recovery tools as method use.
    if (binding.requestBoundarySequence !== settled.requestBoundarySequence ||
      canonicalCardJson(binding.context) !== canonicalCardJson(settled.context) ||
      !settled.selections.some(item => item.versionId === fielding.versionId && item.scopeId === fielding.scope &&
        item.compilationId === binding.compilationId)) continue;

    const traces = view.facts.filter(item => item.kind === "execution" && item.versionId === fielding.versionId &&
      item.trace.taskId === report.turnId && item.trace.compilationId === binding.compilationId);

    // A few settled episodes contextualize learning; tracing every successful
    // tool beat would consume the structural fact budget without new evidence.
    if (traces.length >= 4 || failed.length === 0 && traces.length > 0) continue;

    if (executionAdoptionFor(view.facts, fielding, view.sequence + 1) === undefined) continue;

    const exposureId = fielding.exposureId;

    await options.store.append(current => ({ kind: "execution", factId: shortId("method-execution", [exposureId]),
      versionId: fielding.versionId, sequence: current.sequence + 1, trace: { exposureId,
        taskId: binding.context.taskId, opportunityId: binding.context.opportunityId, scopeId: fielding.scope,
        ...(binding.compilationId === undefined ? {} : { compilationId: binding.compilationId }),
        firstSequence: span.firstSequence, lastSequence: span.lastSequence,
        beat: report.beat, succeededTools: succeeded.slice(0, MAX_TRACE_TOOLS), failures: failed.slice(0, MAX_TRACE_TOOLS),
        omitted: Math.max(0, succeeded.length - MAX_TRACE_TOOLS) + Math.max(0, failed.length - MAX_TRACE_TOOLS) } }));
  }
}
