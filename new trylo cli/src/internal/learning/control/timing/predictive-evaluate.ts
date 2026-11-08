import { failTiming } from "./boundary.js";
import { ExactTiming } from "./exact.js";
import type { Rational } from "./exact.js";
import type { CompiledPredictiveAction, CompiledPredictiveModel, EvaluatedFirstControl, EvaluatedPredictiveAction,
  EvaluatedPredictiveContext, EvaluatedPredictiveModel, FirstControlCertificate, NormalizedPredictiveTimingOptions } from "./predictive-contract.js";

function certificate(controls: readonly EvaluatedFirstControl[], upper: Rational, exact: ExactTiming): FirstControlCertificate {
  const dominates = (item: EvaluatedFirstControl, strict: boolean): boolean => item.low !== null && controls.every(other =>
    other === item || (strict ? exact.compare(item.low!, other.high) > 0 : exact.compare(item.low!, other.high) >= 0));
  const strict = controls.filter(item => dominates(item, true)).map(item => item.firstControl);
  const nonInferior = controls.filter(item => dominates(item, false)).map(item => item.firstControl);
  const exactAtUpper = controls.filter(item => item.low !== null && exact.compare(item.low, item.high) === 0
    && exact.compare(item.high, upper) === 0).map(item => item.firstControl);
  const exactOptimalTies = exactAtUpper.length > 1 ? exactAtUpper : [];

  return { strict, nonInferior, exactOptimalTies, exactTieExhaustive: exactOptimalTies.length > 0
    && controls.every(item => exactOptimalTies.includes(item.firstControl) || exact.compare(item.high, upper) < 0) };
}

/** Memo is legal only under the source's full-history / sufficient-context declaration. */
export function evaluateCompiledPredictive(model: CompiledPredictiveModel, exact: ExactTiming,
  options: NormalizedPredictiveTimingOptions): EvaluatedPredictiveModel {
  const solved = new Map<string, EvaluatedPredictiveContext>();

  function evaluate(action: CompiledPredictiveAction): EvaluatedPredictiveAction {
    if (action.kind === "closed") return { definition: action, value: action.value, children: [] };

    if (action.kind === "closed_upper_frontier") return { definition: action, value: { low: null, high: action.upper }, children: [] };

    let low: Rational | null = action.immediate.low, high = action.immediate.high;
    const children = action.outcomes.map(edge => {
      const child = visit(edge.next), childLow = child.value.low;
      const weightedLow = childLow === null ? null : exact.mul(edge.probability, childLow);
      const weightedHigh = exact.mul(edge.probability, child.value.high);

      low = low === null || weightedLow === null ? null : exact.add(low, weightedLow);
      high = exact.add(high, weightedHigh);

      return { observed: edge.observed, nextContext: edge.next, probability: edge.probability,
        childValue: child.value, weightedValue: { low: weightedLow, high: weightedHigh } };
    });

    return { definition: action, value: { low, high }, children };
  }

  let visited = 0;

  function visit(id: string): EvaluatedPredictiveContext {
    const old = solved.get(id);
    if (old) return old;

    if (visited >= options.nodeLimit) failTiming("planning_limit", "predictive_context_limit", `contexts.${id}`);

    visited += 1;
    const context = model.contexts.get(id)!;
    const actions = context.actions.map(evaluate), first = actions[0]!;
    let lower: Rational | null = null, upper = first.value.high, lowerAction: string | null = null;
    const groups = new Map<string, EvaluatedFirstControl>();

    for (const item of actions) {
      const { low, high } = item.value;

      if (low !== null && (lower === null || exact.compare(low, lower) > 0)) {
        lower = low;
        lowerAction = item.definition.id;
      }

      upper = exact.max(upper, high);
      const control = item.definition.firstControl, group = groups.get(control);
      if (!group) groups.set(control, { firstControl: control, low, high, lowerAction: low === null ? null : item.definition.id });
      else {
        group.high = exact.max(group.high, high);
        if (low !== null && (group.low === null || exact.compare(low, group.low) > 0)) {
          group.low = low;
          group.lowerAction = item.definition.id;
        }
      }
    }

    const controls = [...groups.values()];
    const result = { context, value: { low: lower, high: upper }, lowerAction, actions, controls,
      certificate: certificate(controls, upper, exact) };

    solved.set(id, result);

    return result;
  }

  const root = visit(model.root);

  return { root, contexts: solved };
}
