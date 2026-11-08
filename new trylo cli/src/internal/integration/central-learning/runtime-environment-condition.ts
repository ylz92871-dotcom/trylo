import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { CENTRAL_LEARNING_AGENT_DOMAINS } from "../../learning/control/coordination-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, text } from "../../validation/json-shape.js";
import { CENTRAL_CHANGE_INPUT_VERSION } from "./change-input-contract.js";
import { CENTRAL_SINGLE_ACTION_VERSION } from "./change-single-action-version.js";
import type { CentralLearningExecutionPort } from "./contracts.js";

const ROLE = "host_runtime_environment_condition_not_business_evidence";
const PREFIX = "central-runtime-constraint:";
const READ_RESULT_DELIVERY_VERSION = "native-feedback-notice-read-choices-v6";
const ADVISORY_SOURCE_CONTRACT_VERSION = "authenticated-native-control-transports-v3";
const distinct = (values: readonly string[]) => [...new Set(values)].sort();

/** The host supplies contracts only for peers it actually mounted. Report
 * progress, source bodies and Board revisions do not create new conditions. */
export function centralRuntimeEnvironmentCondition(
  ports: readonly Pick<CentralLearningExecutionPort, "domain" | "acceptResearch">[],
  peerReadContracts: readonly string[],
): CentralRuntimeMaterial {
  const receivers = new Set(ports.filter(port => typeof port.acceptResearch === "function").map(port => port.domain));
  const body = { schemaVersion: 1, role: ROLE, inputVersion: CENTRAL_CHANGE_INPUT_VERSION,
    decisionContractVersion: CENTRAL_SINGLE_ACTION_VERSION,
    readResultDeliveryVersion: READ_RESULT_DELIVERY_VERSION,
    advisorySourceContractVersion: ADVISORY_SOURCE_CONTRACT_VERSION,
    researchReceivers: CENTRAL_LEARNING_AGENT_DOMAINS.filter(domain => receivers.has(domain)),
    peerReadContracts: distinct(peerReadContracts) };
  const value = canonicalJson(body);

  return { ref: `${PREFIX}${contentHashOf(value)}`, kind: "source", text: value, sourceRefs: [] };
}

/** Only this closed, canonical host contract gets complete control delivery.
 * The existing constraint namespace excludes it from business citations. */
export function isCentralRuntimeEnvironmentCondition(material: CentralRuntimeMaterial): boolean {
  if (material.kind !== "source" || material.sourceRefs.length !== 0
    || material.ref !== `${PREFIX}${contentHashOf(material.text)}`) return false;

  let body: unknown;

  try { body = JSON.parse(material.text); } catch { return false; } // Ordinary prose is not a host contract.

  if (!fields(body, ["schemaVersion", "role", "inputVersion", "decisionContractVersion", "researchReceivers", "peerReadContracts",
    ...(typeof body === "object" && body !== null && Object.hasOwn(body, "readResultDeliveryVersion") ? ["readResultDeliveryVersion"] : []),
    ...(typeof body === "object" && body !== null && Object.hasOwn(body, "advisorySourceContractVersion") ? ["advisorySourceContractVersion"] : [])])
    || body.schemaVersion !== 1 || body.role !== ROLE || !text(body.inputVersion, 128)
    || !text(body.decisionContractVersion, 128)
    || Object.hasOwn(body, "readResultDeliveryVersion") && body.readResultDeliveryVersion !== READ_RESULT_DELIVERY_VERSION
      && body.readResultDeliveryVersion !== "returned-read-results-mandatory-v1"
      && body.readResultDeliveryVersion !== "read-results-and-native-status-v2"
      && body.readResultDeliveryVersion !== "read-results-native-status-handoff-receipts-v3"
      && body.readResultDeliveryVersion !== "owned-purpose-and-native-returns-v4"
      && body.readResultDeliveryVersion !== "current-purpose-and-pending-read-results-v5"
    || Object.hasOwn(body, "advisorySourceContractVersion") && body.advisorySourceContractVersion !== ADVISORY_SOURCE_CONTRACT_VERSION
      && body.advisorySourceContractVersion !== "authenticated-historical-organization-controls-v2"
    || !Array.isArray(body.researchReceivers) || !Array.isArray(body.peerReadContracts)
    || !body.researchReceivers.every(domain => CENTRAL_LEARNING_AGENT_DOMAINS.some(known => known === domain))
    || !body.peerReadContracts.every(contract => text(contract, 256))
    || body.peerReadContracts.length > 16) return false;

  const receivers = new Set(body.researchReceivers);

  return material.text === canonicalJson(body)
    && canonicalJson(body.researchReceivers) === canonicalJson(CENTRAL_LEARNING_AGENT_DOMAINS.filter(domain => receivers.has(domain)))
    && canonicalJson(body.peerReadContracts) === canonicalJson(distinct(body.peerReadContracts));
}
