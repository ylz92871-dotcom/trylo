import type { ReadRoutingConditions } from "../../../../../../ports/read-routing.js";
import type { RewardExposure, RewardSource } from "../../../../../reward/contracts.js";
import { canonicalJson, contentHashOf } from "../../../../../control/hash.js";
import { rewardRecordsOf } from "../../../../../control/reward-records.js";
import { READ_STRATEGY_COST_METRIC, READ_STRATEGY_DECISION_POINT, readStrategyEnvironment } from "../domain/index.js";
import { readStrategyInputs } from "../domain/observations.js";
import { identity, sequence } from "../../../../../../validation/json-shape.js";
import { readStrategyBoard } from "../runtime/archive.js";
import { readStrategyConditions } from "../runtime/sensor.js";

export type ReadTopicDemandInput = { readonly boardSequence: number; readonly signal: AbortSignal };

export type ReadTopicDemandResult =
  | { readonly status: "ready"; readonly futureUses: number; readonly basisHash: string; readonly provenanceJson: string }
  | { readonly status: "unmodelled"; readonly reason: string };

export type ReadTopicDemandPolicy = (input: ReadTopicDemandInput) => Promise<ReadTopicDemandResult>;

export type ReadTopicDemandOptions = {
  readonly boardRoot: string; readonly scope: string; readonly enabled: () => boolean;
  readonly conditions: () => ReadRoutingConditions | undefined;
  readonly horizon: number; readonly windowSize: number; readonly prior: { readonly alpha: number; readonly beta: number };
};

type Input = ReturnType<typeof readStrategyInputs>[number];

type Occurrence = { readonly source: RewardSource; readonly key: string; readonly occurredAt: number;
  readonly niche: string; readonly classification: "ordinary" | "trial" | "unclassified" };

// Tool-owned comparison/projection executions never contribute ordinary demand.
const TRIAL_PREFIXES = ["read-topic-trial:", "read-topic-projection:"] as const;
const ORDINARY_CHOICES = new Set(["learned_policy", "no_policy", "scope_mismatch", "condition_mismatch", "evidence_changed", "path_failed",
  "routing_disabled", "routing_asset_invalid", "routing_unavailable"]);
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function classify(exposure: RewardExposure): Occurrence["classification"] {
  const source = exposure.source;
  if ([source.sessionId, source.turnId, source.attemptId, source.eventId].some(value => TRIAL_PREFIXES.some(prefix => value.startsWith(prefix)))
    || source.eventId.startsWith("adapted-failure:")) return "trial";

  const choices = exposure.targets.filter(target => target.kind === "routing_choice");
  if (choices.length !== 1 || (choices[0]!.id !== "whole" && choices[0]!.id !== "stream")) return "unclassified";

  if (choices[0]!.version === "bounded_read_comparison") return "trial";

  return ORDINARY_CHOICES.has(choices[0]!.version) ? "ordinary" : "unclassified";
}

function recentOrdinary(inputs: readonly Input[], unclassified: readonly RewardExposure[], windowSize: number): readonly Occurrence[] | undefined {
  const unique = new Map<string, Occurrence>();
  const occurrences: Occurrence[] = inputs.map(input => ({ source: input.exposure.source, occurredAt: input.exposure.occurredAt,
    key: canonicalJson(input.exposure.source), niche: readStrategyEnvironment(input.conditions), classification: classify(input.exposure) }));

  for (const exposure of unclassified) occurrences.push({ source: exposure.source, occurredAt: exposure.occurredAt,
    key: canonicalJson(exposure.source), niche: "unclassified", classification: classify(exposure) === "trial" ? "trial" : "unclassified" });

  for (const item of occurrences) {
    const { occurredAt, key } = item;
    if (!Number.isFinite(occurredAt) || occurredAt < 0 || occurredAt > 8640000000000000) return undefined;
    const previous = unique.get(key);
    if (previous !== undefined && (previous.occurredAt !== item.occurredAt || previous.niche !== item.niche
      || previous.classification !== item.classification)) return undefined;
    unique.set(key, item);
  }

  // An unclassified read might be ordinary and cannot be silently dropped out of the window denominator.
  const selected = [...unique.values()].filter(item => item.classification !== "trial")
    .sort((left, right) => left.occurredAt - right.occurredAt || compare(left.source.eventId, right.source.eventId) || compare(left.key, right.key))
    .slice(-windowSize);

  return selected.some(item => item.classification !== "ordinary") ? undefined : selected;
}

/** Finite-horizon occurrence frequency from ordinary executions only, never from this learner's own trials. */
export function createReadTopicDemandPolicy(options: ReadTopicDemandOptions): ReadTopicDemandPolicy {
  const { boardRoot, scope, horizon, windowSize } = options, prior = Object.freeze({ ...options.prior });
  const enabled = options.enabled.bind(options), conditions = options.conditions.bind(options);

  if (!identity(scope) || typeof boardRoot !== "string" || !boardRoot.trim()
    || !sequence(horizon) || horizon < 1 || horizon > 1000000 || !sequence(windowSize) || windowSize < 1 || windowSize > 512
    || !Number.isFinite(prior.alpha) || prior.alpha <= 0 || !Number.isFinite(prior.beta) || prior.beta <= 0
    || !Number.isFinite(prior.alpha + prior.beta)) throw new Error("read_topic_demand_configuration");

  return async input => {
    const unavailable = (reason: string): ReadTopicDemandResult => ({ status: "unmodelled", reason });

    if (!enabled() || input.signal.aborted) return unavailable("read_topic_demand_stopped");

    if (!sequence(input.boardSequence)) return unavailable("read_topic_demand_prefix");

    try {
      const captured = conditions();
      if (captured === undefined) return unavailable("read_topic_demand_condition");

      const niche = readStrategyEnvironment(readStrategyConditions(captured));
      const state = await readStrategyBoard(boardRoot);

      if (!enabled() || input.signal.aborted) return unavailable("read_topic_demand_stopped");

      if (state.sequence !== input.boardSequence) return unavailable("read_topic_demand_prefix");

      const current = conditions();
      if (current === undefined || readStrategyEnvironment(readStrategyConditions(current)) !== niche) return unavailable("read_topic_demand_condition_changed");

      const records = rewardRecordsOf(state), inputs = readStrategyInputs(records, scope), admitted = new Set(inputs.map(item => item.exposure.id));
      // The decision point is historical execution vocabulary shared with the retired owner.
      // Only this owner's metric version belongs to the forecast population; malformed
      // records within that version still remain ambiguous rather than disappearing.
      const ambiguous = records.exposures.filter(row => row.context.scope === scope && row.context.taskFamily === READ_STRATEGY_DECISION_POINT
        && row.context.metric.id === READ_STRATEGY_COST_METRIC.id && row.context.metric.version === READ_STRATEGY_COST_METRIC.version
        && !admitted.has(row.id));
      const selected = recentOrdinary(inputs, ambiguous, windowSize);
      if (selected === undefined) return unavailable("read_topic_demand_unclassified");

      const n = selected.length, k = selected.filter(item => item.niche === niche).length;
      if (n === 0 || k === 0) return unavailable("read_topic_demand_no_niche_usage");

      const futureUses = horizon * ((k + prior.alpha) / (n + prior.alpha + prior.beta));
      if (!Number.isFinite(futureUses) || futureUses <= 0 || futureUses > horizon) return unavailable("read_topic_demand_out_of_model");

      const executions = selected.map(item => ({ eventId: item.source.eventId, sourceHash: contentHashOf(item.source),
        occurredAt: item.occurredAt, niche: item.niche, currentNiche: item.niche === niche }));
      const basis = { schemaVersion: 1, estimator: "ordinary-read-beta-binomial-v1", scope, boardSequence: state.sequence,
        niche, horizon, windowSize, prior, n, k, executions, executionsHash: contentHashOf(executions) };
      const basisHash = contentHashOf(basis);

      return { status: "ready", futureUses, basisHash, provenanceJson: canonicalJson({ ...basis, basisHash, futureUses,
        formula: "E[N] = horizon * (k + alpha) / (n + alpha + beta)",
        excludedEventPrefixes: [...TRIAL_PREFIXES, "adapted-failure:"], ordinaryChoiceReasons: [...ORDINARY_CHOICES],
        assumptions: ["Finite horizon counts future ordinary read executions, not wall-clock time or guaranteed future demand",
          "Recorded ordinary read occurrences are exchangeable within this declared recent-window frequency model",
          "RewardSource is the execution identity; duplicates do not add demand and conflicting identities are unmodelled",
          "Quality does not select the frequency sample; known counterfactual/calibration executions and synthetic fallback penalties are excluded",
          "The finite demand forecast and paired utility distribution are treated as conditionally independent within this niche",
          "The host routing-choice markers distinguish ordinary reads; an unclassified occurrence in the window prevents prediction"] }) };
    } catch { return unavailable("read_topic_demand_unavailable"); }
  };
}
