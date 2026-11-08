import { fields, identity, list } from "./json-shape.js";

export const INFORMATION_LIMITS = { jsonChars: 65536, states: 16, actions: 16,
  questions: 8, outcomes: 8, quota: 6, nodes: 100000, decisionStates: 64 } as const;

export type InformationQuestion = {
  readonly id: string;
  readonly cost: number;
  readonly units: number;
  /** Rows index the joint latent state, columns index this question's possible observations. */
  readonly likelihood: readonly (readonly number[])[];
};

export type InformationDecisionTransition = {
  readonly questionId: string;
  /** Outcome-indexed successor state ids. An absent transition makes the question unavailable. */
  readonly next: readonly string[];
};

export type InformationDecisionState = {
  readonly id: string;
  /** The action this domain actually deploys in this state, indexing utilities. */
  readonly action: number;
  readonly transitions: readonly InformationDecisionTransition[];
};

export type InformationDecision = {
  readonly initialState: string;
  readonly states: readonly InformationDecisionState[];
};

type InformationModelBase = {
  readonly prior: readonly number[];
  /** Host-normalized utilities in [-1,1]; costs use this same unit and include verification. */
  readonly utilities: readonly (readonly number[])[];
  readonly questions: readonly InformationQuestion[];
};

export type InformationModelV1 = InformationModelBase & { readonly schemaVersion: 1 };

export type InformationModelV2 = InformationModelBase & { readonly schemaVersion: 2; readonly decision: InformationDecision };

export type InformationModel = InformationModelV1 | InformationModelV2;

export type InformationModelFailure = "topic_model_size" | "topic_model_json" | "topic_model_invalid";

export type InformationRead =
  | { readonly ok: true; readonly model: InformationModel }
  | { readonly ok: false; readonly reason: InformationModelFailure };

/** Shape validation establishes a declared finite model, never its empirical calibration or authority. */
export function readInformationModel(json: string): InformationRead {
  if (typeof json !== "string" || json.length > INFORMATION_LIMITS.jsonChars) return { ok: false, reason: "topic_model_size" };
  let raw: unknown;
  try { raw = JSON.parse(json); }
  catch { return { ok: false, reason: "topic_model_json" }; }
  if (!isModel(raw)) return { ok: false, reason: "topic_model_invalid" };
  return { ok: true, model: raw };
}

const MODEL_FIELDS = ["schemaVersion", "prior", "utilities", "questions"];

function isModel(value: unknown): value is InformationModel {
  if (!fields(value, MODEL_FIELDS) && !fields(value, [...MODEL_FIELDS, "decision"])) return false;

  if (value.schemaVersion === 1 ? !fields(value, MODEL_FIELDS)
    : value.schemaVersion !== 2 || !fields(value, [...MODEL_FIELDS, "decision"])) return false;

  if (!list(value.prior, 1, INFORMATION_LIMITS.states) || !probabilities(value.prior)
    || !list(value.utilities, 1, INFORMATION_LIMITS.actions)
    || !list(value.questions, 0, INFORMATION_LIMITS.questions)) return false;

  const states = value.prior.length;
  if (!value.utilities.every(row => list(row, states, states) && row.every(x => finiteBetween(x, -1, 1)))) return false;

  const outcomesByQuestion = new Map<string, number>();

  for (const question of value.questions) {
    if (!fields(question, ["id", "cost", "units", "likelihood"]) || !identity(question.id) || outcomesByQuestion.has(question.id)
      || !finiteBetween(question.cost, 0, 2) || typeof question.units !== "number"
      || !Number.isSafeInteger(question.units) || question.units < 1 || question.units > INFORMATION_LIMITS.quota
      || !list(question.likelihood, states, states)) return false;

    const first = question.likelihood[0];
    if (!list(first, 1, value.schemaVersion === 1 ? 4 : INFORMATION_LIMITS.outcomes)) return false;

    const outcomes = first.length;
    if (!question.likelihood.every(row => list(row, outcomes, outcomes) && probabilities(row))) return false;

    outcomesByQuestion.set(question.id, outcomes);
  }

  return value.schemaVersion === 1 || isDecision(value.decision, value.utilities.length, outcomesByQuestion);
}

function isDecision(value: unknown, actions: number, outcomesByQuestion: ReadonlyMap<string, number>): value is InformationDecision {
  if (!fields(value, ["initialState", "states"]) || !identity(value.initialState)
    || !list(value.states, 1, INFORMATION_LIMITS.decisionStates)) return false;

  const ids = new Set<string>(), targets: string[] = [];

  for (const state of value.states) {
    if (!fields(state, ["id", "action", "transitions"]) || !identity(state.id) || ids.has(state.id)
      || typeof state.action !== "number" || !Number.isSafeInteger(state.action) || state.action < 0 || state.action >= actions
      || !list(state.transitions, 0, outcomesByQuestion.size)) return false;

    const questions = new Set<string>();

    for (const transition of state.transitions) {
      if (!fields(transition, ["questionId", "next"]) || !identity(transition.questionId) || questions.has(transition.questionId)) return false;
      const outcomes = outcomesByQuestion.get(transition.questionId);
      if (outcomes === undefined || !list(transition.next, outcomes, outcomes) || !transition.next.every(identity)) return false;
      targets.push(...transition.next);
      questions.add(transition.questionId);
    }

    ids.add(state.id);
  }

  return ids.has(value.initialState) && targets.every(target => ids.has(target));
}

function finiteBetween(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
}

function probabilities(values: readonly unknown[]): values is readonly number[] {
  if (!values.every(x => finiteBetween(x, 0, 1))) return false;
  // Permit floating-point summation roundoff, never repair an actually unnormalized model.
  return Math.abs(values.reduce((sum, x) => sum + x, 0) - 1) <= 64 * Number.EPSILON;
}
