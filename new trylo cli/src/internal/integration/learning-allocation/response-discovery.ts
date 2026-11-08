import type { BoardState } from "../../learning/control/state.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";
import type { CentralResponseOpportunity, CentralResponseTarget } from "../../learning/control/decision/prediction-input.js";
import type { CentralResponseFamilyBinding } from "../../learning/control/decision/prediction-reference.js";
import { isCentralResponseOpportunity } from "../../learning/control/decision/prediction-validation.js";
import { isCentralPursuitObjective } from "../../learning/control/decision/pursuit-validation.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { activeEmpiricalTopicSupport, type TopicMeasurementSelector, type TopicPairedMeasurement } from "../../learning/domains/shared/topics/empirical-model.js";
import { fields, identity, list } from "../../validation/json-shape.js";
import { topicMeasurements } from "../learning-topics/measurement-source.js";
import { centralResponseRegistrationsOf, type CentralResponseRegistration } from "./response-registration.js";
import type { CentralResponseProtocol } from "./response-protocol.js";

/** The original domain confirms target/condition/family applicability. Remapping
 * to a different target/window also needs this stage's actual baseline instance. */
export type CentralResponseDiscoveryBinding = {
  readonly opportunityId: string; readonly targetKey: string; readonly conditionRef: string;
  readonly policyFamilyRef: string; readonly sourceRef: string;
  readonly baseline?: { readonly ruleKey: string; readonly instanceRef: string; readonly sourceRef: string };
};

export type CentralResponseDiscoveryProtocol = {
  readonly selector: TopicMeasurementSelector; readonly protocol: CentralResponseProtocol | null;
};

export type CentralResponseDiscoveryGroup = {
  readonly target: CentralResponseTarget;
  readonly protocols: readonly CentralResponseDiscoveryProtocol[];
  readonly registrations: readonly CentralResponseRegistration[];
  readonly opportunities: readonly CentralResponseOpportunity[];
  readonly familyBindings: readonly CentralResponseFamilyBinding[];
};

type Unmatched = { readonly opportunityId: string; readonly reason: string; readonly sourceRefs: readonly string[] };

export type CentralResponseDiscoveryInput = {
  readonly board: BoardState; readonly scope: string; readonly candidates: readonly CentralPursuitCandidate[];
  readonly bindings?: readonly CentralResponseDiscoveryBinding[];
};

export type CentralResponseDiscoveryResult = { readonly status: "ready"; readonly groups: readonly CentralResponseDiscoveryGroup[];
  readonly unmatched: readonly Unmatched[] } | { readonly status: "invalid"; readonly reason: string };

function validBinding(value: unknown): value is CentralResponseDiscoveryBinding {
  return fields(value, ["opportunityId", "targetKey", "conditionRef", "policyFamilyRef", "sourceRef"])
    && Object.values(value).every(identity)
    || fields(value, ["opportunityId", "targetKey", "conditionRef", "policyFamilyRef", "sourceRef", "baseline"])
    && [value.opportunityId, value.targetKey, value.conditionRef, value.policyFamilyRef, value.sourceRef].every(identity)
    && fields(value.baseline, ["ruleKey", "instanceRef", "sourceRef"]) && Object.values(value.baseline).every(identity);
}

function validInput(input: CentralResponseDiscoveryInput): boolean {
  if ((!fields(input, ["board", "scope", "candidates"]) && !fields(input, ["board", "scope", "candidates", "bindings"]))
    || !identity(input.scope) || !list(input.candidates, 0, 30)
    || !input.candidates.every(row => fields(row, ["opportunity", "source", "readiness", "target", "fee", "purpose", "objective"])
      && isCentralResponseOpportunity(row.opportunity) && row.opportunity.scope === input.scope && isCentralPursuitObjective(row.objective))) return false;

  const ids = new Set(input.candidates.map(row => row.opportunity.opportunityId)), bindings = input.bindings ?? [];

  return ids.size === input.candidates.length && list(bindings, 0, 30) && bindings.every(validBinding)
    && bindings.every(row => ids.has(row.opportunityId)) && new Set(bindings.map(row => row.opportunityId)).size === bindings.length;
}

function selectorOf(row: TopicMeasurementSelector): TopicMeasurementSelector {
  return { scope: row.scope, experimentRef: row.experimentRef, experimentVersion: row.experimentVersion,
    conditionHash: row.conditionHash, utilityUnit: row.utilityUnit };
}

/** Inspect only existing canonical measurement members and their correction links.
 * This discovers protocol identity; the original resolver still owns revisions. */
export function centralResponseLegacySelector(registration: CentralResponseRegistration, rows: readonly TopicPairedMeasurement[], through: number):
  TopicMeasurementSelector | undefined {
  const byId = new Map(rows.map(row => [row.id, row])), children = new Map<string, string[]>();

  for (const row of rows) if (row.supersedes !== undefined) {
    const values = children.get(row.supersedes) ?? [];
    values.push(row.id);
    children.set(row.supersedes, values);
  }

  const queue = [...registration.window.measurementIds], visited = new Set<string>(), members: TopicPairedMeasurement[] = [];

  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (visited.has(id)) continue;
    visited.add(id);
    const row = byId.get(id);
    if (row !== undefined) {
      members.push(row);
      if (row.supersedes !== undefined) queue.push(row.supersedes);
    }
    queue.push(...children.get(id) ?? []);
  }

  if (members.length === 0) return undefined;

  const selector = selectorOf(members[0]!);
  if (selector.scope !== registration.window.opportunity.scope || selector.conditionHash !== registration.window.opportunity.conditionRef
    || selector.utilityUnit !== registration.target.utilityUnit
    || !members.every(row => canonicalJson(selectorOf(row)) === canonicalJson(selector))
    || activeEmpiricalTopicSupport(selector, rows, through) === undefined) return undefined;

  return selector;
}

function exactMatch(opportunity: CentralResponseOpportunity, registration: CentralResponseRegistration): boolean {
  const previous = registration.window.opportunity;
  return opportunity.targetRef === registration.target.key && opportunity.conditionRef === previous.conditionRef
    && opportunity.stage === previous.stage && canonicalJson(opportunity.offer.owner) === canonicalJson(previous.offer.owner)
    && opportunity.offer.policyRef === previous.offer.policyRef;
}

function selectedRegistrations(candidate: CentralPursuitCandidate, binding: CentralResponseDiscoveryBinding | undefined,
  registrations: readonly CentralResponseRegistration[]): readonly CentralResponseRegistration[] {
  return registrations.filter(record => binding === undefined ? exactMatch(candidate.opportunity, record)
    : record.target.key === binding.targetKey && record.window.opportunity.conditionRef === binding.conditionRef
      && record.protocol?.policyFamilyRef === binding.policyFamilyRef
      && record.window.opportunity.stage === candidate.opportunity.stage
      && canonicalJson(record.window.opportunity.offer.owner) === canonicalJson(candidate.opportunity.offer.owner));
}

function mappedOpportunity(candidate: CentralPursuitCandidate, target: CentralResponseTarget,
  binding: CentralResponseDiscoveryBinding | undefined): CentralResponseOpportunity | undefined {
  const original = candidate.opportunity;
  if (binding?.baseline !== undefined && binding.baseline.ruleKey !== target.baselineRuleKey) return undefined;
  if ((original.targetRef !== target.key || original.windowRef !== target.windowRef) && binding?.baseline === undefined) return undefined;
  return { ...original, targetRef: target.key, windowRef: target.windowRef, conditionRef: binding?.conditionRef ?? original.conditionRef,
    baselineRef: binding?.baseline?.instanceRef ?? original.baselineRef };
}

type MutableGroup = { target: CentralResponseTarget; protocols: CentralResponseDiscoveryProtocol[];
  registrations: CentralResponseRegistration[]; opportunities: CentralResponseOpportunity[]; familyBindings: CentralResponseFamilyBinding[] };

function appendFamily(group: MutableGroup, binding: CentralResponseFamilyBinding): boolean {
  const previous = group.familyBindings.find(row => row.instanceRef === binding.instanceRef);
  if (previous !== undefined) return previous.familyRef === binding.familyRef;
  group.familyBindings.push(binding);
  return true;
}

/** Canonical lookup only. Does not infer causal effects from same-domain labels,
 * construct bounds for legacy rows, select a target by value or rewrite dispatch identities. */
export function lookupCentralResponseEvidence(input: CentralResponseDiscoveryInput): CentralResponseDiscoveryResult {
  if (!validInput(input)) return { status: "invalid", reason: "response_discovery_input" };

  const decoded = centralResponseRegistrationsOf(input.board, input.scope);
  if (decoded.status !== "ready") return decoded;

  let measurements: TopicPairedMeasurement[] = [];

  if (decoded.value.some(row => row.protocol === null)) {
    try { measurements = topicMeasurements(input.board.rewardV2Facts ?? [], input.scope); }
    catch (error) {
      if (error instanceof SyntaxError || error instanceof Error && error.message === "topic_measurement_corrupt") {
        return { status: "invalid", reason: "response_discovery_measurement_corrupt" };
      }
      throw error;
    }
  }

  const groups = new Map<string, MutableGroup>(), unmatched: Unmatched[] = [];

  for (const candidate of input.candidates) {
    const id = candidate.opportunity.opportunityId, binding = input.bindings?.find(row => row.opportunityId === id);
    const matches = selectedRegistrations(candidate, binding, decoded.value);
    const missing = (reason: string, sourceRefs: readonly string[] = []) => unmatched.push({ opportunityId: id, reason,
      sourceRefs: [...new Set([candidate.opportunity.sourceRef, ...(binding === undefined ? [] : [binding.sourceRef]), ...sourceRefs])] });

    if (matches.length === 0) {
      missing("response_registration_not_matched");
      continue;
    }

    const targetKeys = [...new Set(matches.map(row => canonicalJson(row.target)))];
    if (targetKeys.length !== 1) {
      missing("response_target_ambiguous", matches.map(row => row.factId));
      continue;
    }

    const target = matches[0]!.target, opportunity = mappedOpportunity(candidate, target, binding);
    if (opportunity === undefined) {
      missing("response_baseline_binding_required", matches.map(row => row.factId));
      continue;
    }

    // The canonical decoder owns target/comparison qualification. Preserve both
    // whole-policy responses and deployed-response diagnostics without upgrading either.
    const qualified = matches.filter(row => row.window.comparison.kind !== "unqualified");
    if (qualified.length === 0) {
      missing("response_learning_contrast_unqualified", matches.map(row => row.factId));
      continue;
    }

    const families = [...new Set(qualified.flatMap(row => row.protocol === null ? [] : [row.protocol.policyFamilyRef]))];
    if (binding === undefined && families.length > 1) {
      missing("response_family_ambiguous", qualified.map(row => row.factId));
      continue;
    }

    const group = groups.get(targetKeys[0]!) ?? { target, protocols: [], registrations: [], opportunities: [], familyBindings: [] };
    let identified = false;

    for (const record of qualified) {
      const selector = record.protocol === null ? centralResponseLegacySelector(record, measurements, input.board.sequence) : selectorOf(record.protocol);
      if (selector === undefined) {
        missing("response_legacy_selector_unidentified", [record.factId]);
        continue;
      }

      identified = true;

      if (!group.registrations.some(row => row.factId === record.factId)) group.registrations.push(record);

      const protocol = { selector, protocol: record.protocol };
      if (!group.protocols.some(row => canonicalJson(row) === canonicalJson(protocol))) group.protocols.push(protocol);

      if (record.protocol !== null && !appendFamily(group, { instanceRef: record.window.opportunity.instanceRef,
        familyRef: record.protocol.policyFamilyRef, sourceRef: record.protocol.familySourceRef })) {
        return { status: "invalid", reason: "response_discovery_family_conflict" };
      }
    }

    if (!identified) continue;

    const familyRef = binding?.policyFamilyRef ?? families[0];
    if (familyRef !== undefined && !appendFamily(group, { instanceRef: opportunity.instanceRef, familyRef,
      sourceRef: binding?.sourceRef ?? qualified.find(row => row.protocol !== null)!.protocol!.familySourceRef })) {
      return { status: "invalid", reason: "response_discovery_family_conflict" };
    }

    group.opportunities.push(opportunity);
    groups.set(targetKeys[0]!, group);
  }

  return { status: "ready", groups: [...groups.values()], unmatched };
}
