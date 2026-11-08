import { canonicalJson, contentHashOf } from "../../../control/hash.js";
import { fields, identity, list, sequence } from "./json-shape.js";
import { INFORMATION_LIMITS, readInformationModel, type InformationDecision, type InformationModelV2 } from "./information-model.js";

export type JointEmpiricalPolicy = {
  readonly scope: string; readonly protocolId: string; readonly protocolVersion: string;
  readonly conditionHash: string; readonly utilityUnit: string; readonly futureUses: number; readonly utilityScale: number;
  readonly utilityBounds: { readonly minimum: number; readonly maximum: number }; readonly priorStrength: number;
  readonly actions: readonly string[];
  readonly questions: readonly { readonly experimentRef: string; readonly experimentVersion: string;
    readonly units: number; readonly outcomes: readonly string[] }[];
};

export type JointObservation = { readonly experimentRef: string; readonly experimentVersion: string;
  readonly outcome: string; readonly fullStudyCost: number; readonly checkRef: string };

export type JointKnownObservation = Pick<JointObservation, "experimentRef" | "experimentVersion" | "outcome" | "checkRef">;

export type JointActionUtility = { readonly actionId: string; readonly value: number; readonly checkRef: string };

type JointIdentity = Pick<JointEmpiricalPolicy, "scope" | "protocolId" | "protocolVersion" | "conditionHash" | "utilityUnit"> & {
  /** One immutable execution/input version; ordinary input changes are new episodes, not corrections. */
  readonly episodeId: string; readonly sourceRef: string; readonly supersedes?: string; readonly provenanceJson?: string;
};

type JointResult = { readonly kind: "measured"; readonly observations: readonly JointObservation[]; readonly actionUtilities: readonly JointActionUtility[] }
  | { readonly kind: "unknown"; readonly reason: string };

export type JointOutcome = JointIdentity & { readonly measurementId: string } & JointResult;

/** Distributive replacement of measurementId: measured/unknown remains a discriminated union. */
export type TopicJointMeasurement = JointIdentity & { readonly id: string; readonly sequence: number; readonly provenanceHash?: string } & JointResult;

type Measured = Extract<TopicJointMeasurement, { readonly kind: "measured" }>;

export type JointEmpiricalModel =
  | { readonly status: "unvalued"; readonly reason: "topic_joint_policy" | "topic_joint_binding" | "topic_joint_conflict"
      | "topic_joint_unknown" | "topic_joint_support" | "topic_joint_out_of_model" }
  | { readonly status: "ready"; readonly modelJson: string; readonly provenance: {
      readonly estimator: "current-target-joint-empirical-v1"; readonly policyHash: string; readonly supportIds: readonly string[];
      readonly supportHash: string; readonly stateCounts: readonly number[]; readonly observationVectors: readonly (readonly string[])[];
      readonly knownObservations: readonly JointKnownObservation[]; readonly knownObservationsHash: string;
      readonly boardSequence: number; readonly assumptions: readonly string[];
    } };

const MAX_MEASUREMENTS = 512;
const BASE = ["episodeId", "scope", "protocolId", "protocolVersion", "conditionHash", "utilityUnit", "sourceRef", "kind"];
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const checkRef = (value: unknown): value is string => identity(value) && /^(checker|execution):.+$/.test(value);

/** Policy validation has one owner; learned/model-written values cannot declare a new authority. */
export function isJointEmpiricalPolicy(value: unknown): value is JointEmpiricalPolicy {
  if (!fields(value, ["scope", "protocolId", "protocolVersion", "conditionHash", "utilityUnit", "futureUses", "utilityScale",
    "utilityBounds", "priorStrength", "actions", "questions"])
    || ![value.scope, value.protocolId, value.protocolVersion, value.utilityUnit].every(identity) || !hash(value.conditionHash)
    || !finite(value.futureUses) || value.futureUses <= 0 || value.futureUses > 1000000
    || !finite(value.utilityScale) || value.utilityScale <= 0 || !finite(value.priorStrength) || value.priorStrength <= 0 || value.priorStrength > 1000000
    || !fields(value.utilityBounds, ["minimum", "maximum"]) || !finite(value.utilityBounds.minimum) || !finite(value.utilityBounds.maximum)
    || value.utilityBounds.minimum > value.utilityBounds.maximum
    || value.futureUses * Math.max(Math.abs(value.utilityBounds.minimum), Math.abs(value.utilityBounds.maximum)) > value.utilityScale
    || !list(value.actions, 1, INFORMATION_LIMITS.actions) || !value.actions.every(identity) || new Set(value.actions).size !== value.actions.length
    || !list(value.questions, 1, INFORMATION_LIMITS.questions)) return false;

  const refs = new Set<string>();

  for (const question of value.questions) {
    if (!fields(question, ["experimentRef", "experimentVersion", "units", "outcomes"]) || !identity(question.experimentRef)
      || !identity(question.experimentVersion) || refs.has(question.experimentRef) || !sequence(question.units) || question.units < 1 || question.units > INFORMATION_LIMITS.quota
      || !list(question.outcomes, 2, INFORMATION_LIMITS.outcomes) || !question.outcomes.every(identity)
      || new Set(question.outcomes).size !== question.outcomes.length) return false;
    refs.add(question.experimentRef);
  }

  return true;
}

function validProvenance(value: Record<string, unknown>, representation: "outcome" | "measurement"): boolean {
  const jsonPresent = Object.hasOwn(value, "provenanceJson"), hashPresent = Object.hasOwn(value, "provenanceHash");
  if (!jsonPresent) return !hashPresent;

  const json = value.provenanceJson, maximum = representation === "outcome" ? 16384 : 32768;
  if (typeof json !== "string" || json.length > maximum || Buffer.byteLength(json, "utf8") > maximum * 4
    || (representation === "measurement" && !hashPresent)) return false;

  try {
    const parsed: unknown = JSON.parse(json);
    return representation === "outcome" || (hash(value.provenanceHash) && value.provenanceHash === contentHashOf(parsed));
  }
  catch { return false; }
}

function recordShape(value: unknown, representation: "outcome" | "measurement"): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const optional = ["supersedes", "provenanceJson", ...(representation === "measurement" ? ["provenanceHash"] : [])].filter(key => Object.hasOwn(value, key));
  const keys = [...BASE, ...(representation === "outcome" ? ["measurementId"] : ["id", "sequence"]), ...optional];
  const kind: unknown = Reflect.get(value, "kind");
  const resultKeys = kind === "measured" ? ["observations", "actionUtilities"] : kind === "unknown" ? ["reason"] : undefined;
  if (resultKeys === undefined || !fields(value, [...keys, ...resultKeys])) return false;

  if (![value.episodeId, value.scope, value.protocolId, value.protocolVersion, value.utilityUnit].every(identity)
    || !hash(value.conditionHash) || !checkRef(value.sourceRef) || (Object.hasOwn(value, "supersedes") && !identity(value.supersedes))
    || !validProvenance(value, representation)) return false;

  if (kind === "unknown") return identity(value.reason);

  if (!list(value.observations, 1, INFORMATION_LIMITS.questions) || !list(value.actionUtilities, 1, INFORMATION_LIMITS.actions)) return false;

  const refs = new Set<string>(), actions = new Set<string>();

  for (const observation of value.observations) {
    if (!fields(observation, ["experimentRef", "experimentVersion", "outcome", "fullStudyCost", "checkRef"])
      || !identity(observation.experimentRef) || !identity(observation.experimentVersion) || !identity(observation.outcome) || refs.has(observation.experimentRef)
      || !finite(observation.fullStudyCost) || observation.fullStudyCost < 0 || !checkRef(observation.checkRef)) return false;
    refs.add(observation.experimentRef);
  }

  for (const utility of value.actionUtilities) {
    if (!fields(utility, ["actionId", "value", "checkRef"]) || !identity(utility.actionId) || actions.has(utility.actionId)
      || !finite(utility.value) || !checkRef(utility.checkRef)) return false;
    actions.add(utility.actionId);
  }

  return true;
}

function outcomeShape(value: unknown): value is JointOutcome { return recordShape(value, "outcome") && identity(value.measurementId); }

function measurementShape(value: unknown): value is TopicJointMeasurement {
  return recordShape(value, "measurement") && identity(value.id) && sequence(value.sequence) && value.sequence > 0;
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Shape/source binding is necessary; only an injected host checker authenticates the observation. */
export function readJointOutcome(value: unknown): JointOutcome | undefined { return outcomeShape(value) ? frozen(structuredClone(value)) : undefined; }

export function readJointMeasurement(value: unknown): TopicJointMeasurement | undefined { return measurementShape(value) ? frozen(structuredClone(value)) : undefined; }

function sameCohort(policy: JointEmpiricalPolicy, row: TopicJointMeasurement): boolean {
  return row.scope === policy.scope && row.protocolId === policy.protocolId && row.protocolVersion === policy.protocolVersion
    && row.conditionHash === policy.conditionHash && row.utilityUnit === policy.utilityUnit;
}

function activeSupport(policy: JointEmpiricalPolicy, rows: readonly TopicJointMeasurement[], through: number): readonly TopicJointMeasurement[] | undefined {
  const kept = new Map<string, TopicJointMeasurement>(), replaced = new Set<string>();

  for (const value of rows) {
    const row = readJointMeasurement(value);
    if (row === undefined) return undefined;
    if (row.sequence > through || !sameCohort(policy, row)) continue;
    if (kept.has(row.id)) return undefined;
    kept.set(row.id, row);
  }

  for (const row of kept.values()) {
    if (row.supersedes === undefined) continue;
    const parent = kept.get(row.supersedes);
    if (parent === undefined || parent.episodeId !== row.episodeId || parent.sequence >= row.sequence || replaced.has(parent.id)) return undefined;
    replaced.add(parent.id);
  }

  const active = [...kept.values()].filter(row => !replaced.has(row.id)).sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return new Set(active.map(row => row.episodeId)).size === active.length ? active : undefined;
}

function completeRecord(policy: JointEmpiricalPolicy, row: Measured): boolean {
  return row.observations.length === policy.questions.length && row.actionUtilities.length === policy.actions.length
    && policy.questions.every(question => row.observations.some(observation => observation.experimentRef === question.experimentRef
      && observation.experimentVersion === question.experimentVersion && question.outcomes.includes(observation.outcome)))
    && policy.actions.every(actionId => row.actionUtilities.some(utility => utility.actionId === actionId
      && utility.value >= policy.utilityBounds.minimum && utility.value <= policy.utilityBounds.maximum));
}

function mean(values: readonly number[]): number {
  return values.reduce((average, value, index) => average + (value - average) / (index + 1), 0);
}

function readKnown(policy: JointEmpiricalPolicy, input: readonly JointKnownObservation[] | undefined): readonly JointKnownObservation[] | undefined {
  if (input === undefined) return Object.freeze([]);

  if (!Array.isArray(input) || input.length > policy.questions.length) return undefined;

  const refs = new Set<string>(), known: JointKnownObservation[] = [];

  for (const value of input) {
    if (!fields(value, ["experimentRef", "experimentVersion", "outcome", "checkRef"]) || !identity(value.experimentRef)
      || !identity(value.experimentVersion) || !identity(value.outcome) || !checkRef(value.checkRef) || refs.has(value.experimentRef)) return undefined;
    const question = policy.questions.find(question => question.experimentRef === value.experimentRef);
    if (question === undefined || question.experimentVersion !== value.experimentVersion || !question.outcomes.includes(value.outcome)) return undefined;
    refs.add(value.experimentRef);
    known.push(Object.freeze({ experimentRef: value.experimentRef, experimentVersion: value.experimentVersion,
      outcome: value.outcome, checkRef: value.checkRef }));
  }

  return Object.freeze(known);
}

function removeKnownTransitions(decision: InformationDecision, knownIds: ReadonlySet<string>): InformationDecision | undefined {
  if (knownIds.size === 0) return decision;
  try { return { ...decision, states: decision.states.map(state => ({ ...state,
    transitions: state.transitions.filter(transition => !knownIds.has(transition.questionId)) })) }; }
  catch { return undefined; } // The canonical information-model validator below owns the remaining graph checks.
}

/**
 * Current-target finite diagnosis from complete host-checked episodes. Theta is the full
 * observed vector, so likelihoods are conditional one-hot maps, not an independence claim.
 * This estimates neither parameter-learning gain nor the paired Dirichlet future-policy VOI.
 */
export function buildJointEmpiricalModel(input: { readonly policy: JointEmpiricalPolicy; readonly boardSequence: number;
  readonly measurements: readonly TopicJointMeasurement[]; readonly questions: readonly { readonly experimentRef: string; readonly questionId: string }[];
  readonly decision: InformationDecision; readonly knownObservations?: readonly JointKnownObservation[] }): JointEmpiricalModel {
  const { policy } = input, unvalued = (reason: Extract<JointEmpiricalModel, { status: "unvalued" }>["reason"]): JointEmpiricalModel => ({ status: "unvalued", reason });

  if (!isJointEmpiricalPolicy(policy) || !sequence(input.boardSequence) || !Array.isArray(input.measurements)
    || input.measurements.length > MAX_MEASUREMENTS) return unvalued("topic_joint_policy");

  const known = readKnown(policy, input.knownObservations);
  if (known === undefined) return unvalued("topic_joint_binding");

  const knownRefs = new Set(known.map(observation => observation.experimentRef));
  if (!Array.isArray(input.questions) || input.questions.length > policy.questions.length
    || !input.questions.every(row => fields(row, ["experimentRef", "questionId"]) && identity(row.experimentRef) && identity(row.questionId))
    || new Set(input.questions.map(row => row.experimentRef)).size !== input.questions.length
    || new Set(input.questions.map(row => row.questionId)).size !== input.questions.length
    || input.questions.some(row => !policy.questions.some(question => question.experimentRef === row.experimentRef))
    || policy.questions.some(question => !knownRefs.has(question.experimentRef) && !input.questions.some(row => row.experimentRef === question.experimentRef))) return unvalued("topic_joint_binding");

  const support = activeSupport(policy, input.measurements, input.boardSequence);
  if (support === undefined) return unvalued("topic_joint_conflict");

  if (support.some(row => row.kind === "unknown")) return unvalued("topic_joint_unknown");

  const measured = support.filter((row): row is Measured => row.kind === "measured");
  if (measured.length === 0) return unvalued("topic_joint_support");

  if (!measured.every(row => completeRecord(policy, row))) return unvalued("topic_joint_out_of_model");

  const groups = new Map<string, { readonly vector: readonly string[]; readonly rows: Measured[] }>();

  for (const row of measured) {
    const vector = policy.questions.map(question => row.observations.find(observation => observation.experimentRef === question.experimentRef)!.outcome);
    const key = canonicalJson(vector), group = groups.get(key) ?? { vector: Object.freeze(vector), rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  if (groups.size > INFORMATION_LIMITS.states) return unvalued("topic_joint_out_of_model");

  const ordered = [...groups.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, group]) => group);
  const count = measured.length, k = ordered.length;
  const prior = ordered.map(group => (group.rows.length + policy.priorStrength / k) / (count + policy.priorStrength));
  const compatible = ordered.map(group => known.every(observation => group.vector[policy.questions.findIndex(question => question.experimentRef === observation.experimentRef)] === observation.outcome));
  const mass = prior.reduce((sum, value, index) => sum + (compatible[index] ? value : 0), 0);
  if (mass === 0) return unvalued("topic_joint_out_of_model");

  const knownIds = new Set(input.questions.filter(question => knownRefs.has(question.experimentRef)).map(question => question.questionId));
  const decision = removeKnownTransitions(input.decision, knownIds);
  if (decision === undefined) return unvalued("topic_joint_out_of_model");

  const model: InformationModelV2 = { schemaVersion: 2,
    prior: known.length === 0 ? prior : prior.map((value, index) => compatible[index] ? value / mass : 0),
    utilities: policy.actions.map(actionId => ordered.map(group => mean(group.rows.map(row =>
      policy.futureUses * row.actionUtilities.find(utility => utility.actionId === actionId)!.value / policy.utilityScale)))),
    questions: policy.questions.flatMap((question, index) => knownRefs.has(question.experimentRef) ? [] : [{ id: input.questions.find(row => row.experimentRef === question.experimentRef)!.questionId,
      units: question.units, cost: mean(measured.map(row => row.observations.find(observation => observation.experimentRef === question.experimentRef)!.fullStudyCost / policy.utilityScale)),
      likelihood: ordered.map(group => question.outcomes.map(outcome => group.vector[index] === outcome ? 1 : 0)) }]), decision };
  let modelJson: string;

  try { modelJson = canonicalJson(model); }
  catch { return unvalued("topic_joint_out_of_model"); }

  if (!readInformationModel(modelJson).ok) return unvalued("topic_joint_out_of_model");

  return { status: "ready", modelJson, provenance: frozen({ estimator: "current-target-joint-empirical-v1" as const,
    policyHash: contentHashOf(policy), supportIds: measured.map(row => row.id), supportHash: contentHashOf(support),
    stateCounts: ordered.map(group => group.rows.length), observationVectors: ordered.map(group => group.vector), boardSequence: input.boardSequence,
    knownObservations: known, knownObservationsHash: contentHashOf(known),
    assumptions: ["Current target belongs to the declared protocol/condition; historical complete episodes are exchangeable representatives",
      "The finite latent support contains only actually observed complete vectors; unseen combinations are outside this model",
      "Symmetric Dirichlet concentration over observed vectors is explicitly declared, not learned from text or fabricated episodes",
      "Action utilities use frozen empirical group means; within-vector heterogeneity and calibration remain unverified",
      "Each study cost is a frozen whole-record mean; cost variation conditional on a vector is not represented",
      "Future-use demand and this conditional utility table are treated as independent within the declared target niche",
      "Study costs and action utilities share the declared objective unit; the supplied decision graph owns actual deployment actions",
      "Trusted current-target known observations condition the prior without adding historical samples; their questions and charges are removed",
      "This is current-target condition inference, not an estimate of joint parameter-learning gain or future-policy VOI"] }) };
}
