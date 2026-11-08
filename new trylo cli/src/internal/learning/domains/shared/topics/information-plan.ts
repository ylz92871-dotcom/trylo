import { INFORMATION_LIMITS, readInformationModel, type InformationDecisionState, type InformationModel, type InformationModelFailure } from "./information-model.js";
import { informationBranches } from "./information-observation.js";

export type InformationPlan =
  | { readonly status: "invalid"; readonly reason: InformationModelFailure | "topic_planning_budget" }
  | { readonly status: "planning_limit"; readonly nodes: number }
  | { readonly status: "planned"; readonly questionId: string | null;
      readonly value: number; readonly baseline: number; readonly netGain: number; readonly nodes: number };

type Choice = { readonly value: number; readonly questionId: string | null };

const VALUE_TOLERANCE = 1e-12;

/**
 * Finite expected-utility Bellman calculation within a domain. Questions are usable once each;
 * observations must be conditionally independent given the JOINT latent state. This is not
 * an estimator, a causal identifier, a risk-sensitive RW2 deployment policy or an execution grant.
 */
export function planTopicInformation(json: string, quota: number, nodeLimit = 20000): InformationPlan {
  const parsed = readInformationModel(json);
  if (!parsed.ok) return { status: "invalid", reason: parsed.reason };

  if (!Number.isSafeInteger(quota) || quota < 0 || quota > INFORMATION_LIMITS.quota
    || !Number.isSafeInteger(nodeLimit) || nodeLimit < 1 || nodeLimit > INFORMATION_LIMITS.nodes) {
    return { status: "invalid", reason: "topic_planning_budget" };
  }

  const model = parsed.model, prior = normalize(model.prior);
  const states = new Map(model.schemaVersion === 2 ? model.decision.states.map(state => [state.id, state] as const) : []);
  const initial = model.schemaVersion === 2 ? states.get(model.decision.initialState)! : undefined;
  const baseline = deploy(model, prior, initial);
  let nodes = 0;

  function visit(belief: readonly number[], available: number, remaining: number, state: InformationDecisionState | undefined): Choice | null {
    if (nodes === nodeLimit) return null;

    nodes += 1;
    let best: Choice = { value: deploy(model, belief, state), questionId: null };

    for (let index = 0; index < model.questions.length; index += 1) {
      const question = model.questions[index]!;
      if ((available & (1 << index)) === 0 || question.units > remaining) continue;

      const transition = state?.transitions.find(item => item.questionId === question.id);
      if (model.schemaVersion === 2 && transition === undefined) continue;

      let value = -question.cost;

      for (const branch of informationBranches(belief, question)) {
        const successor = transition === undefined ? undefined : states.get(transition.next[branch.outcome]!)!;
        const next = visit(branch.belief, available & ~(1 << index), remaining - question.units, successor);
        // A completed prefix is not a certified optimum. Never publish its best-so-far choice.
        if (next === null) return null;
        value += branch.mass * next.value;
      }

      // Within numerical tolerance prefer stopping; among strictly improving ties keep input order.
      if (value > best.value + VALUE_TOLERANCE) best = { value, questionId: question.id };
    }

    return best;
  }

  const result = visit(prior, (1 << model.questions.length) - 1, quota, initial);

  return result === null ? { status: "planning_limit", nodes }
    : { status: "planned", ...result, baseline, netGain: result.value - baseline, nodes };
}

function normalize(values: readonly number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map(value => value / total);
}

function deploy(model: InformationModel, belief: readonly number[], state: InformationDecisionState | undefined): number {
  const expected = (row: readonly number[]) => row.reduce((sum, utility, index) => sum + utility * belief[index]!, 0);
  // Schema 2 can deploy only the domain's declared current action; all state references were validated on read.
  return model.schemaVersion === 2 ? expected(model.utilities[state!.action]!) : Math.max(...model.utilities.map(expected));
}

