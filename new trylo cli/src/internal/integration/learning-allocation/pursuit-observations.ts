import type { BoardState } from "../../learning/control/state.js";
import type { CentralPursuitObservation } from "../../learning/control/decision/pursuit-contract.js";
import { isCentralPursuitObservation } from "../../learning/control/decision/pursuit-validation.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isRewardV2Draft, isRewardV2Fact, validRewardV2Prefix } from "../../learning/reward/v2-facts.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";

const ALGORITHM = "central-pursuit-outcome-v1", TREATMENT_ALGORITHM = "central-pursuit-outcome-v2";

export type CentralPursuitObservationDraft = Omit<CentralPursuitObservation, "sequence"> & {
  /** Exact preceding RewardV2 fact ID for this unit, not a unit or revision ID. */
  readonly supersedes?: string;
};

type Invalid = { readonly status: "invalid"; readonly reason: string };

export type CentralPursuitObservationDraftResult = { readonly status: "ready"; readonly value: RewardV2Draft } | Invalid;

export type CentralPursuitObservationReadResult = {
  readonly status: "ready";
  readonly observations: readonly CentralPursuitObservation[];
  /** Derived pointers for the original host to address a later correction. No new writer. */
  readonly heads: readonly { readonly unitId: string; readonly factId: string }[];
  readonly sourceRef: string;
} | Invalid;

const OBSERVATION_FIELDS = ["unitId", "scope", "conditionRef", "objective", "grantId", "stageRef", "sourceRef", "revisionRef", "outcome"];

function validDraft(value: unknown): value is CentralPursuitObservationDraft {
  if (!(fields(value, OBSERVATION_FIELDS) || fields(value, [...OBSERVATION_FIELDS, "supersedes"])
    || fields(value, [...OBSERVATION_FIELDS, "treatmentRef"]) || fields(value, [...OBSERVATION_FIELDS, "treatmentRef", "supersedes"]))) return false;
  const { supersedes, ...observation } = value;
  return (!Object.hasOwn(value, "supersedes") || identity(supersedes))
    && isCentralPursuitObservation({ ...observation, sequence: 1 });
}

/** Build an immutable fact for the existing RewardV2 writer. The source supplies
 * qualified/no-result/pending evidence; completed alone never implies qualified. */
export function createCentralPursuitObservationDraft(input: CentralPursuitObservationDraft): CentralPursuitObservationDraftResult {
  if (!validDraft(input)) return { status: "invalid", reason: "pursuit_observation_shape" };

  // Keep v1 bytes/IDs unchanged. Old readers skip the v2 algorithm rather than
  // accepting new treatment/model semantics under their old strict decoder.
  const schemaVersion = input.treatmentRef === undefined && input.objective.resourceModel === undefined ? 1 : 2;
  const payload = { schemaVersion, observation: input }, payloadJson = canonicalJson(payload);
  const value: RewardV2Draft = { id: `pursuit-observation:${contentHashOf(payload)}`,
    scope: input.scope, kind: "feedback", algorithmVersion: schemaVersion === 1 ? ALGORITHM : TREATMENT_ALGORITHM, payloadJson };

  return isRewardV2Draft(value) ? { status: "ready", value } : { status: "invalid", reason: "pursuit_observation_capacity" };
}

type Seen = { readonly factId: string; readonly observation: CentralPursuitObservation };

function sameUnit(left: CentralPursuitObservation, right: CentralPursuitObservation): boolean {
  return left.unitId === right.unitId && left.scope === right.scope && left.conditionRef === right.conditionRef
    && left.grantId === right.grantId && left.stageRef === right.stageRef && canonicalJson(left.objective) === canonicalJson(right.objective)
    && (left.treatmentRef === undefined || left.treatmentRef === right.treatmentRef);
}

/** Replay only the owner's effective source heads at this canonical Board prefix.
 * A correction replaces a prior label; it never adds another independent trial. */
export function readCentralPursuitObservations(board: BoardState, scope: string): CentralPursuitObservationReadResult {
  if (board === null || typeof board !== "object" || !sequence(board.sequence) || !identity(scope)) {
    return { status: "invalid", reason: "pursuit_observation_prefix" };
  }

  const facts = board.rewardV2Facts ?? [];
  if (!Array.isArray(facts) || !facts.every(isRewardV2Fact) || !validRewardV2Prefix(facts, board.sequence)) {
    return { status: "invalid", reason: "pursuit_observation_prefix" };
  }

  const seen = new Map<string, Seen>(), heads = new Map<string, Seen>();

  for (const fact of facts) {
    if (fact.scope !== scope || (fact.algorithmVersion !== ALGORITHM && fact.algorithmVersion !== TREATMENT_ALGORITHM)) continue;

    if (fact.kind !== "feedback") return { status: "invalid", reason: "pursuit_observation_kind" };

    let raw: unknown;

    try { raw = JSON.parse(fact.payloadJson); }
    catch { return { status: "invalid", reason: "pursuit_observation_json" }; }

    if (!fields(raw, ["schemaVersion", "observation"]) || raw.schemaVersion !== (fact.algorithmVersion === ALGORITHM ? 1 : 2) || !validDraft(raw.observation)
      || raw.observation.scope !== scope) return { status: "invalid", reason: "pursuit_observation_shape" };

    const expected = createCentralPursuitObservationDraft(raw.observation);
    if (expected.status !== "ready" || expected.value.id !== fact.id || expected.value.algorithmVersion !== fact.algorithmVersion) {
      return { status: "invalid", reason: "pursuit_observation_identity" };
    }

    const { supersedes, ...stored } = raw.observation;
    const observation: CentralPursuitObservation = { ...stored, sequence: fact.sequence };
    const current = heads.get(observation.unitId);

    if (supersedes === undefined) {
      if (current !== undefined) return { status: "invalid", reason: "pursuit_observation_duplicate_unit" };
    } else {
      const previous = seen.get(supersedes);
      // Prefix order rules out forward references and cycles without a second revision ledger.
      if (previous === undefined) return { status: "invalid", reason: "pursuit_observation_revision_parent" };
      if (!sameUnit(previous.observation, observation)) return { status: "invalid", reason: "pursuit_observation_revision_binding" };
      if (current?.factId !== supersedes) return { status: "invalid", reason: "pursuit_observation_revision_fork" };
      if (previous.observation.revisionRef === observation.revisionRef) return { status: "invalid", reason: "pursuit_observation_revision_reused" };
    }

    const next: Seen = { factId: fact.id, observation };

    seen.set(fact.id, next);
    heads.set(observation.unitId, next);
  }

  const effective = [...heads.values()].sort((a, b) => a.observation.sequence - b.observation.sequence);

  return { status: "ready", observations: effective.map(row => row.observation),
    heads: effective.map(row => ({ unitId: row.observation.unitId, factId: row.factId })),
    sourceRef: `pursuit-observations:${contentHashOf({ scope, boardSequence: board.sequence, effective })}` };
}
