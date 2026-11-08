import type { BoardState } from "../../learning/control/state.js";
import { isRewardV2Draft, isRewardV2Fact, validRewardV2Prefix, type RewardV2Draft } from "../../learning/reward/v2-facts.js";
import type { CentralResponseTarget } from "../../learning/control/decision/prediction-input.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { isCentralResponseWindow, type CentralResponseWindow } from "./response-source.js";
import { isCentralResponseTarget } from "../../learning/control/decision/prediction-validation.js";
import { isCentralResponseProtocol, type CentralResponseProtocol } from "./response-protocol.js";

const VERSION = "central-response-window-v1", PROTOCOL_VERSION = "central-response-window-v2", ESTIMAND_VERSION = "central-response-window-v3";

export type CentralResponseWindowRegistration = Omit<CentralResponseWindow, "registeredAtSequence" | "boundary">;

type RegistrationResult<T> = { readonly status: "ready"; readonly value: T } | { readonly status: "invalid"; readonly reason: string };

/** Returns a draft for the existing RewardV2 Board writer. Does not append or grant.
 * The cohort and declared contrast are frozen before its outcomes become available. */
export function createCentralResponseWindowDraft(registration: CentralResponseWindowRegistration,
  target: CentralResponseTarget, protocol?: CentralResponseProtocol): RegistrationResult<RewardV2Draft> {
  if (!isCentralResponseTarget(target) || !fields(registration, ["opportunity", "unitId", "grantId", "measurementIds", "comparison"])
    || !isCentralResponseWindow({ ...registration, boundary: "complete", registeredAtSequence: 0 }, 0, target)) {
    return { status: "invalid", reason: "response_registration_shape" };
  }

  if (protocol !== undefined && (!isCentralResponseProtocol(protocol) || protocol.scope !== registration.opportunity.scope
    || protocol.conditionHash !== registration.opportunity.conditionRef || protocol.utilityUnit !== target.utilityUnit)) {
    return { status: "invalid", reason: "response_registration_protocol_binding" };
  }

  // v1/v2 bytes stay unchanged. Explicit estimands use a new algorithm so old
  // readers skip the fact instead of silently accepting whole-policy semantics.
  const schemaVersion = target.estimand !== undefined ? 3 : protocol === undefined ? 1 : 2;
  const payload = schemaVersion === 1 ? { schemaVersion: 1, target, registration }
    : schemaVersion === 2 ? { schemaVersion: 2, target, registration, protocol }
      : { schemaVersion: 3, target, registration, protocol: protocol ?? null };
  const value: RewardV2Draft = { id: `response-registration:${contentHashOf(schemaVersion === 1 ? [target, registration] : payload)}`,
    scope: registration.opportunity.scope, algorithmVersion: schemaVersion === 1 ? VERSION : schemaVersion === 2 ? PROTOCOL_VERSION : ESTIMAND_VERSION,
    kind: "learning_decision",
    payloadJson: canonicalJson(payload) };

  return isRewardV2Draft(value) ? { status: "ready", value } : { status: "invalid", reason: "response_registration_capacity" };
}

export type CentralResponseRegistration = { readonly target: CentralResponseTarget; readonly window: CentralResponseWindow;
  readonly protocol: CentralResponseProtocol | null; readonly factId: string };

/** Decode the immutable registration generations from the original Board. The
 * original fact sequence, never a supplied JSON timestamp, is the source birth. */
export function centralResponseRegistrationsOf(board: BoardState, scope: string):
  RegistrationResult<readonly CentralResponseRegistration[]> {
  if (board === null || typeof board !== "object" || !sequence(board.sequence) || !identity(scope)) {
    return { status: "invalid", reason: "response_registration_prefix" };
  }

  const facts = board.rewardV2Facts ?? [];
  if (!Array.isArray(facts) || !facts.every(isRewardV2Fact) || !validRewardV2Prefix(facts, board.sequence)) {
    return { status: "invalid", reason: "response_registration_prefix" };
  }

  const result: CentralResponseRegistration[] = [], units = new Set<string>();

  for (const fact of facts) {
    if (fact.scope !== scope || ![VERSION, PROTOCOL_VERSION, ESTIMAND_VERSION].includes(fact.algorithmVersion)) continue;

    if (fact.kind !== "learning_decision") return { status: "invalid", reason: "response_registration_prefix" };

    let raw: unknown;

    try { raw = JSON.parse(fact.payloadJson); }
    catch { return { status: "invalid", reason: "response_registration_json" }; }

    const legacy = fact.algorithmVersion === VERSION;
    const schemaVersion = legacy ? 1 : fact.algorithmVersion === PROTOCOL_VERSION ? 2 : 3;
    if (!fields(raw, legacy ? ["schemaVersion", "target", "registration"] : ["schemaVersion", "target", "registration", "protocol"])
      || raw.schemaVersion !== schemaVersion || !isCentralResponseTarget(raw.target)
      || (schemaVersion === 3) !== (raw.target.estimand !== undefined)
      || !fields(raw.registration, ["opportunity", "unitId", "grantId", "measurementIds", "comparison"])) {
      return { status: "invalid", reason: "response_registration_shape" };
    }

    const target = raw.target;
    const protocol = legacy ? null : raw.protocol;
    if (protocol === null && schemaVersion === 2 || protocol !== null && !isCentralResponseProtocol(protocol)) {
      return { status: "invalid", reason: "response_registration_protocol_binding" };
    }

    const window = { ...raw.registration, boundary: "complete", registeredAtSequence: fact.sequence };

    // The registered JSON has now passed the same canonical opportunity/window guard.
    if (!isCentralResponseWindow(window, board.sequence, target)) {
      return { status: "invalid", reason: "response_registration_shape" };
    }

    const registered = window;
    const draft = createCentralResponseWindowDraft({ opportunity: registered.opportunity, unitId: registered.unitId,
      grantId: registered.grantId, measurementIds: registered.measurementIds, comparison: registered.comparison }, target, protocol ?? undefined);
    if (draft.status !== "ready" || draft.value.id !== fact.id || draft.value.algorithmVersion !== fact.algorithmVersion
      || registered.opportunity.scope !== scope) {
      return { status: "invalid", reason: "response_registration_identity" };
    }

    const unitRef = canonicalJson([target, registered.unitId]);

    // The canonical Board owns retention/capacity. A valid target does not stop
    // being readable merely because another independent window was registered.
    if (units.has(unitRef)) return { status: "invalid", reason: "response_registration_duplicate_or_capacity" };

    units.add(unitRef);
    result.push({ target, window: registered, protocol, factId: fact.id });
  }

  return { status: "ready", value: result };
}

/** Compatibility projection: valid v1 IDs and windows retain their exact meaning;
 * v1 records have no protocol/bounds inferred by the canonical decoder. */
export function centralResponseWindowsOf(board: BoardState, target: CentralResponseTarget, scope: string):
  RegistrationResult<readonly CentralResponseWindow[]> {
  if (!isCentralResponseTarget(target)) return { status: "invalid", reason: "response_registration_target" };
  const decoded = centralResponseRegistrationsOf(board, scope);
  return decoded.status === "invalid" ? decoded : { status: "ready", value: decoded.value
    .filter(record => canonicalJson(record.target) === canonicalJson(target)).map(record => record.window) };
}
