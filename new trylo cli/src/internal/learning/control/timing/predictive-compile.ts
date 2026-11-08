import { fields, identity, list } from "../../../validation/json-shape.js";
import { contentHashOf } from "../hash.js";
import { failTiming, requireTiming } from "./boundary.js";
import { ExactTiming, readTimingBits } from "./exact.js";
import type { CompiledPredictiveAction, CompiledPredictiveContext, CompiledPredictiveModel,
  NormalizedPredictiveTimingOptions, ValueBounds } from "./predictive-contract.js";

/** Analysis work caps, not learning intervals, grants, or wall-clock promises. */
const CAPS = Object.freeze({ contexts: 32, actions: 8, outcomes: 8, nodeLimit: 1000 });

export function readPredictiveTimingOptions(options: unknown = undefined): NormalizedPredictiveTimingOptions {
  if (options === undefined) return { maxBits: readTimingBits(), nodeLimit: 128 };

  requireTiming(fields(options, []) || fields(options, ["maxBits"]) || fields(options, ["nodeLimit"])
    || fields(options, ["maxBits", "nodeLimit"]), "predictive_options_shape", "options");
  const maxBits = readTimingBits(options.maxBits);
  const nodeLimit = Object.hasOwn(options, "nodeLimit") ? options.nodeLimit : 128;

  requireTiming(typeof nodeLimit === "number" && Number.isSafeInteger(nodeLimit) && nodeLimit >= 1 && nodeLimit <= CAPS.nodeLimit,
    "predictive_node_limit", "options.nodeLimit");

  return { maxBits, nodeLimit };
}

function readBounds(raw: unknown, exact: ExactTiming, at: string): ValueBounds {
  requireTiming(list(raw, 2, 2), "value_bound_pair", at);
  const low = exact.from(raw[0], `${at}[0]`), high = exact.from(raw[1], `${at}[1]`);
  requireTiming(exact.compare(low, high) <= 0, "value_bound_order", at);
  return { low, high };
}

function readAction(raw: unknown, exact: ExactTiming, at: string): CompiledPredictiveAction {
  requireTiming(typeof raw === "object" && raw !== null && !Array.isArray(raw), "action_shape", at);
  const row = raw as Record<string, unknown>;
  if (Array.isArray(row.firstControl)) failTiming("unsupported_model", "mixed_first_control", `${at}.firstControl`);

  requireTiming(identity(row.id) && identity(row.firstControl), "action_identity", at);
  const common = { id: row.id, firstControl: row.firstControl };

  if (row.kind === "closed") {
    requireTiming(fields(row, ["kind", "id", "firstControl", "programRef", "value"])
      && identity(row.programRef), "closed_action_shape", at);
    return { ...common, kind: "closed", programRef: row.programRef, value: readBounds(row.value, exact, `${at}.value`) };
  }

  if (row.kind === "closed_upper_frontier") {
    requireTiming(fields(row, ["kind", "id", "firstControl", "frontierScopeRef", "upper"])
      && identity(row.frontierScopeRef), "frontier_shape", at);
    return { ...common, kind: "closed_upper_frontier", frontierScopeRef: row.frontierScopeRef,
      upper: exact.from(row.upper, `${at}.upper`) };
  }

  if (row.kind !== "edge") failTiming("unsupported_model", "predictive_action_kind", `${at}.kind`);

  requireTiming(fields(row, ["kind", "id", "firstControl", "operationRef", "firstLeg", "immediate", "outcomeCoverage", "outcomes"])
    && identity(row.operationRef) && row.firstLeg === "source-declared-feasible" && row.outcomeCoverage === "complete"
    && list(row.outcomes, 1, CAPS.outcomes), "edge_shape_or_coverage", at);
  const outcomes = row.outcomes.map((edge, index) => {
    const edgeAt = `${at}.outcomes[${index}]`;
    requireTiming(fields(edge, ["observed", "weight", "next"]) && identity(edge.observed) && identity(edge.next),
      "outcome_shape", edgeAt);
    return { observed: edge.observed, next: edge.next, weight: exact.from(edge.weight, `${edgeAt}.weight`) };
  });

  requireTiming(new Set(outcomes.map(edge => edge.observed)).size === outcomes.length, "duplicate_observation", at);
  const probabilities = exact.normalize(outcomes.map(edge => edge.weight), `${at}.outcomes`);

  return { ...common, kind: "edge", operationRef: row.operationRef, immediate: readBounds(row.immediate, exact, `${at}.immediate`),
    outcomes: outcomes.flatMap((edge, index) => {
      const probability = probabilities[index]!;
      return probability.n === 0n ? [] : [{ observed: edge.observed, next: edge.next, probability }];
    }) };
}

function validateGraph(contexts: ReadonlyMap<string, CompiledPredictiveContext>, root: string): void {
  const active = new Set<string>(), done = new Set<string>();

  function visit(id: string): void {
    requireTiming(!active.has(id), "positive_context_cycle", `contexts.${id}`);

    if (done.has(id)) return;

    const context = contexts.get(id);

    requireTiming(context, "positive_context_missing", `contexts.${id}`);
    active.add(id);

    for (const action of context.actions) if (action.kind === "edge") for (const edge of action.outcomes) visit(edge.next);

    active.delete(id);
    done.add(id);
  }

  visit(root);
  requireTiming(done.size === contexts.size, "unreachable_context", "contexts");
}

export function compilePredictiveTiming(raw: unknown, exact: ExactTiming): CompiledPredictiveModel {
  requireTiming(fields(raw, ["schemaVersion", "modelKind", "sourceScope", "basisRef", "evaluationRef", "utilityUnit",
    "coverage", "root", "reference", "contexts"]), "predictive_model_shape", "model");

  if (raw.schemaVersion !== 1 || raw.modelKind !== "finite_predictive_expected") {
    failTiming("unsupported_model", "predictive_schema_or_objective", "model");
  }

  requireTiming(identity(raw.sourceScope) && identity(raw.basisRef) && identity(raw.evaluationRef) && identity(raw.utilityUnit)
    && identity(raw.root) && raw.coverage === "complete-declared-family" && list(raw.contexts, 1, CAPS.contexts),
  "predictive_basis_or_coverage", "model");
  let reference: CompiledPredictiveModel["reference"] = null;
  if (raw.reference !== null) {
    requireTiming(fields(raw.reference, ["scopeRef", "value"]) && identity(raw.reference.scopeRef), "reference_shape", "reference");
    reference = { scopeRef: raw.reference.scopeRef, value: readBounds(raw.reference.value, exact, "reference.value") };
  }

  const contexts = new Map<string, CompiledPredictiveContext>();

  raw.contexts.forEach((row, index) => {
    const at = `contexts[${index}]`;

    requireTiming(fields(row, ["id", "actionCoverage", "noMoreAction", "actions"]) && identity(row.id)
      && row.actionCoverage === "complete" && list(row.actions, 1, CAPS.actions), "context_shape_or_coverage", at);
    requireTiming(!contexts.has(row.id), "duplicate_context", at);
    const actions = row.actions.map((action, actionIndex) => readAction(action, exact, `${at}.actions[${actionIndex}]`));

    requireTiming(new Set(actions.map(action => action.id)).size === actions.length, "duplicate_action", at);
    const noMore = actions.filter(action => action.firstControl === "no_more_processing");

    requireTiming(row.noMoreAction === null ? noMore.length === 0
      : identity(row.noMoreAction) && noMore.length === 1 && noMore[0]!.id === row.noMoreAction
        && noMore[0]!.kind !== "edge", "no_more_coverage_pointer", at);
    contexts.set(row.id, { id: row.id, noMoreAction: row.noMoreAction as string | null, actions });
  });
  requireTiming(contexts.has(raw.root), "root_missing", "root");
  validateGraph(contexts, raw.root);

  return { basis: { sourceScope: raw.sourceScope, basisRef: raw.basisRef, evaluationRef: raw.evaluationRef, utilityUnit: raw.utilityUnit },
    modelHash: contentHashOf(raw), root: raw.root, reference, contexts };
}
