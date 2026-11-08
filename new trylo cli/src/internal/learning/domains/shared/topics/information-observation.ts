import { canonicalJson } from "../../../control/hash.js";
import { readInformationModel, type InformationModel, type InformationModelFailure, type InformationQuestion } from "./information-model.js";

export type ConditionedObservation = { readonly logProbability: number; readonly belief: readonly number[] };

export function conditionInformation(belief: readonly number[], question: InformationQuestion, outcome: number): ConditionedObservation | undefined {
  const logs = belief.map((p, index) => Math.log(p) + Math.log(question.likelihood[index]![outcome]!));
  const maximum = Math.max(...logs);
  if (maximum === -Infinity) return undefined;
  const weights = logs.map(value => Math.exp(value - maximum)), total = weights.reduce((sum, value) => sum + value, 0);
  return { logProbability: maximum + Math.log(total), belief: weights.map(weight => weight / total) };
}

export function* informationBranches(belief: readonly number[], question: InformationQuestion) {
  for (let outcome = 0; outcome < question.likelihood[0]!.length; outcome += 1) {
    const conditioned = conditionInformation(belief, question, outcome);
    if (conditioned === undefined) continue;
    const mass = Math.exp(conditioned.logProbability);
    if (mass === 0) continue;
    yield { outcome, mass, belief: conditioned.belief };
  }
}

export type ObservationUpdate = { readonly status: "updated"; readonly model: InformationModel; readonly modelJson: string;
  readonly spentUnits: number; readonly logProbability: number }
  | { readonly status: "rejected"; readonly reason: InformationModelFailure | "topic_observation_invalid" | "topic_observation_out_of_model" };

/** A measured outcome conditions the declared model; this does not authenticate its real-world source. */
export function applyTopicObservation(json: string, questionId: string, outcome: number): ObservationUpdate {
  const parsed = readInformationModel(json);
  if (!parsed.ok) return { status: "rejected", reason: parsed.reason };

  const question = parsed.model.questions.find(item => item.id === questionId);
  if (question === undefined || !Number.isSafeInteger(outcome) || outcome < 0 || outcome >= question.likelihood[0]!.length) {
    return { status: "rejected", reason: "topic_observation_invalid" };
  }

  const decision = parsed.model.schemaVersion === 2 ? parsed.model.decision : undefined;
  const transition = decision?.states.find(state => state.id === decision.initialState)!
    .transitions.find(item => item.questionId === questionId);
  if (parsed.model.schemaVersion === 2 && transition === undefined) return { status: "rejected", reason: "topic_observation_invalid" };

  const observation = conditionInformation(parsed.model.prior, question, outcome);
  if (observation === undefined) return { status: "rejected", reason: "topic_observation_out_of_model" };

  const questions = parsed.model.questions.filter(item => item.id !== questionId);
  const model: InformationModel = parsed.model.schemaVersion === 2
    ? { ...parsed.model, prior: observation.belief, questions, decision: {
      initialState: transition!.next[outcome]!,
      states: parsed.model.decision.states.map(state => ({ ...state,
        transitions: state.transitions.filter(item => item.questionId !== questionId) })),
    } }
    : { ...parsed.model, prior: observation.belief, questions };

  return { status: "updated", model, modelJson: canonicalJson(model), spentUnits: question.units, logProbability: observation.logProbability };
}
