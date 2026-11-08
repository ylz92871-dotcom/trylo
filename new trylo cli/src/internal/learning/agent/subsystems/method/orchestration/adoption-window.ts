import { shortId } from "../../../../domains/shared/hash.js";
import { adoptedUnitBefore, adoptionUnitKey, adoptionWindowClosed, type AdoptionWindow } from "../domain/adoption-window.js";
import { isMethodExecutionSpan, type MethodExecutionSpan } from "../domain/execution-trace.js";
import { METHOD_CONTEXT_TOOL } from "../experience-port.js";
import type { ExperienceRuntimeOptions } from "./experience-runtime.js";

/** Run both after settlement and before a resumed planning request. A local
 * closure precedes IO so a failed durable write cannot reopen this host. */
export async function closeMissedAdoptionWindows(options: ExperienceRuntimeOptions, taskId: string,
  span: MethodExecutionSpan | undefined, locallyClosed: Set<string>): Promise<void> {
  if (span === undefined) return;

  if (!isMethodExecutionSpan(span)) throw new Error("invalid_method_execution_span");

  const businessTool = span.toolNames.find(name => name !== METHOD_CONTEXT_TOOL);
  if (businessTool === undefined) return;

  const view = await options.store.load();
  const pending = new Map<string, { readonly versionId: string; readonly window: AdoptionWindow }>();

  for (const fielding of view.fieldings ?? []) {
    const binding = fielding.binding;
    if (fielding.turnId !== taskId || fielding.exposureId === undefined || binding === undefined ||
      binding.requestBoundarySequence === undefined || binding.requestBoundarySequence >= span.firstSequence) continue;

    const unit = { versionId: fielding.versionId, taskId,
      ...(binding.compilationId === undefined ? {} : { compilationId: binding.compilationId }) };
    const key = adoptionUnitKey(unit);

    if (adoptedUnitBefore(view.facts, unit, view.sequence + 1)) {
      locallyClosed.delete(key);
      continue;
    }

    locallyClosed.add(key);

    if (adoptionWindowClosed(view.facts, unit) || pending.has(key)) continue;

    pending.set(key, { versionId: fielding.versionId,
      window: { exposureId: fielding.exposureId, taskId, opportunityId: binding.context.opportunityId,
        scopeId: fielding.scope, ...(binding.compilationId === undefined ? {} : { compilationId: binding.compilationId }),
        firstSequence: span.firstSequence, lastSequence: span.lastSequence, businessTool } });
  }

  // Protect every affected local unit before the first awaited write. One
  // failed append cannot leave the remaining displayed methods open to bias.
  for (const [key, item] of pending) {
    const factId = shortId("method-adoption-window", [key]);
    await options.store.append(current => current.facts.find(fact => fact.factId === factId) ??
      { kind: "adoption_window_closed", factId, versionId: item.versionId, sequence: current.sequence + 1, window: item.window });
  }
}
