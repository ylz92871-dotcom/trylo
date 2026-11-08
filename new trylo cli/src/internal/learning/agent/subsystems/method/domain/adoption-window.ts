import type { MethodExperienceFact } from "./experience-facts.js";
import type { ExperienceSource } from "./experience-state.js";
import { representativeAdoptionsOf } from "./opportunity-representative.js";

export type AdoptionUnit = { readonly versionId: string; readonly taskId: string; readonly compilationId?: string };

export type AdoptionWindow = {
  readonly exposureId: string; readonly taskId: string; readonly opportunityId: string; readonly scopeId: string;
  readonly compilationId?: string; readonly firstSequence: number; readonly lastSequence: number; readonly businessTool: string;
};

export function adoptionUnitKey(unit: AdoptionUnit): string {
  return JSON.stringify([unit.versionId, unit.taskId, unit.compilationId]);
}

export function adoptedUnitBefore(facts: readonly MethodExperienceFact[], unit: AdoptionUnit, beforeSequence: number): boolean {
  return representativeAdoptionsOf(facts, beforeSequence).some(fact => adoptionUnitKey({ versionId: fact.versionId,
    taskId: fact.context.taskId, ...(fact.decision.compilationId === undefined ? {} : { compilationId: fact.decision.compilationId }) }) === adoptionUnitKey(unit));
}

export function adoptionWindowClosed(facts: readonly MethodExperienceFact[], unit: AdoptionUnit,
  beforeSequence = Number.POSITIVE_INFINITY): boolean {
  return facts.some(fact => fact.kind === "adoption_window_closed" && fact.sequence < beforeSequence &&
    adoptionUnitKey({ versionId: fact.versionId, ...fact.window }) === adoptionUnitKey(unit));
}

export function isAdoptionWindow(value: unknown): value is AdoptionWindow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const item = value as Record<string, unknown>;

  return Object.keys(item).every(key => ["exposureId", "taskId", "opportunityId", "scopeId", "compilationId",
    "firstSequence", "lastSequence", "businessTool"].includes(key)) &&
    [item.exposureId, item.taskId, item.opportunityId, item.scopeId, item.businessTool].every(text) &&
    item.businessTool !== "method_context" && (item.compilationId === undefined || text(item.compilationId)) &&
    ordinal(item.firstSequence) && ordinal(item.lastSequence) && item.lastSequence >= item.firstSequence;
}

/** Closure observes business settlement, never a helpfulness verdict. */
export function adoptionWindowFactError(source: ExperienceSource,
  fact: Extract<MethodExperienceFact, { kind: "adoption_window_closed" }>): string | undefined {
  const window = fact.window, unit = { versionId: fact.versionId, ...window };
  const fielding = source.fieldings?.find(item => item.exposureId === window.exposureId && item.versionId === fact.versionId &&
    item.turnId === window.taskId && item.scope === window.scopeId && item.binding !== undefined && item.binding.context.opportunityId === window.opportunityId &&
    item.binding.compilationId === window.compilationId && item.useSequence !== undefined && item.useSequence < fact.sequence);
  const boundary = fielding?.binding?.requestBoundarySequence;
  if (boundary === undefined || window.firstSequence <= boundary) return "adoption_window_without_fresh_delivery";

  if (adoptedUnitBefore(source.facts, unit, fact.sequence)) return "adoption_window_already_adopted";

  return adoptionWindowClosed(source.facts, unit, fact.sequence) ? "adoption_window_already_closed" : undefined;
}

function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 200; }

function ordinal(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
