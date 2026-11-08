import { ExactTiming } from "./exact.js";
import type { CompiledPredictiveModel, EvaluatedPredictiveAction, EvaluatedPredictiveContext,
  EvaluatedPredictiveModel, PartialValue } from "./predictive-contract.js";

export function formatPredictiveTiming(model: CompiledPredictiveModel, result: EvaluatedPredictiveModel, exact: ExactTiming) {
  const value = (pair: PartialValue) => ({ low: pair.low === null ? null : exact.text(pair.low), high: exact.text(pair.high) });

  function action(item: EvaluatedPredictiveAction) {
    const row = item.definition;
    const source = row.kind === "closed" ? { programRef: row.programRef }
      : row.kind === "edge" ? { operationRef: row.operationRef } : { frontierScopeRef: row.frontierScopeRef };

    return { id: row.id, kind: row.kind, firstControl: row.firstControl, source,
      immediate: row.kind === "edge" ? value(row.immediate) : row.kind === "closed" ? value(row.value) : null,
      value: value(item.value), children: item.children.map(child => ({ observed: child.observed,
        probability: exact.text(child.probability), nextContext: child.nextContext,
        conditionalChildValue: value(child.childValue), weightedContribution: value(child.weightedValue) })) };
  }

  function context(item: EvaluatedPredictiveContext) {
    const chosen = item.lowerAction === null ? undefined : item.actions.find(row => row.definition.id === item.lowerAction);
    const definition = chosen?.definition;
    // An edge gets here only if every positive child had a complete lower witness.
    const lowerWitness = chosen && definition && definition.kind !== "closed_upper_frontier" ? {
      context: item.context.id, action: definition.id, firstControl: definition.firstControl,
      source: definition.kind === "closed" ? { programRef: definition.programRef } : { operationRef: definition.operationRef },
      children: chosen.children.map(child => ({ observed: child.observed, nextContext: child.nextContext })),
    } : null;

    return { context: item.context.id, noMoreAction: item.context.noMoreAction,
      witnessStatus: lowerWitness === null ? "no_witness" as const : "bounded_with_witness" as const,
      value: value(item.value), gap: item.value.low === null ? null : exact.text(exact.sub(item.value.high, item.value.low)),
      lowerWitness, firstControlCertificate: item.certificate,
      firstControlComparisonScope: item.controls.length === 1 ? "sole_control_vacuous" as const : "other_first_controls_only" as const,
      controls: item.controls.map(control => {
        const competitors = item.controls.filter(other => other !== control);
        const competitorUpper = competitors.length === 0 ? null
          : competitors.slice(1).reduce((upper, other) => exact.max(upper, other.high), competitors[0]!.high);

        return { firstControl: control.firstControl, value: value(control), lowerWitnessAction: control.lowerAction,
          competitorUpper: competitorUpper === null ? null : exact.text(competitorUpper),
          guaranteedMargin: control.low === null || competitorUpper === null ? null : exact.text(exact.sub(control.low, competitorUpper)),
        };
      }), actions: item.actions.map(action) };
  }

  const root = context(result.root), reference = model.reference;

  return { status: "analyzed" as const, schemaVersion: 1 as const, modelKind: "finite_predictive_expected" as const,
    modelHash: model.modelHash, basis: model.basis, root: model.root, visitedContexts: result.contexts.size,
    witnessStatus: root.witnessStatus, value: root.value, gap: root.gap,
    reference: reference === null ? null : { scopeRef: reference.scopeRef, value: value(reference.value) },
    increment: reference === null ? null : {
      low: result.root.value.low === null ? null : exact.text(exact.sub(result.root.value.low, reference.value.high)),
      high: exact.text(exact.sub(result.root.value.high, reference.value.low)),
    },
    firstControlCertificate: root.firstControlCertificate,
    firstControlComparisonScope: root.firstControlComparisonScope,
    bestKnownLowerWitness: root.lowerWitness,
    contexts: [...result.contexts.values()].map(context),
    continuationScope: { modelHash: model.modelHash, basisRef: model.basis.basisRef, evaluationRef: model.basis.evaluationRef,
      matchingObservation: "context_action_observed" as const, unmatchedObservation: "requires_new_source_model" as const,
      revalidate: ["source_scope", "owner_feasibility", "remaining_resources_and_progress", "receipt_coverage", "calendar_and_business_state"],
      declarationLimits: "bounds_coverage_context_sufficiency_and_live_permission_remain_source_conditions" as const },
  };
}

export type PredictiveTimingAnalysis = ReturnType<typeof formatPredictiveTiming>;
