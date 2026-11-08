import type { LearningDomain } from "../../learning/control/contracts.js";
import type { GroundedLearningTopic } from "../../learning/domains/shared/topics/contracts.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import type { TopicExperimentBindingRecord } from "../../learning/domains/shared/topics/experiment-binding.js";

export type TopicProbeExpectation = {
  readonly scope: string; readonly domain: LearningDomain; readonly allocationId: string; readonly valuationId: string;
  readonly questionId: string; readonly modelHash: string; readonly units: number; readonly spendId: string; readonly claimId: string;
  readonly checkerVersion: string; readonly executionVersion: string;
  readonly decisionBasisHash?: string;
  readonly experimentBindingHash?: string;
};

export type TopicProbeReceipt = TopicProbeExpectation & { readonly schemaVersion: 1; readonly receiptRef: string;
  readonly sourceRef: string; readonly measurementHash: string; readonly outcome: number };

/** Initial measurement has a protocol and an explicit allowance, without pretending a model exists. */
export type TopicCalibrationExpectation = Omit<TopicProbeExpectation, "questionId" | "modelHash" | "decisionBasisHash" | "experimentBindingHash"> & {
  readonly purpose: "calibration"; readonly protocolHash: string;
};

export type TopicCalibrationReceipt = TopicCalibrationExpectation & { readonly schemaVersion: 1; readonly receiptRef: string;
  readonly sourceRef: string; readonly measurementHash: string; readonly outcome: number };

export type TopicProbePort = {
  /** Host maps the question to an approved experiment; discriminator text is never a command or permission. */
  run(input: TopicProbeExpectation & { readonly topic: GroundedLearningTopic;
    readonly experimentBinding?: TopicExperimentBindingRecord; readonly signal: AbortSignal }): Promise<string>;
  /** Reads the host checker's real immutable observation, not caller-supplied/self-rated result JSON. */
  readObservation(receiptRef: string, expected: TopicProbeExpectation, signal: AbortSignal): Promise<string>;
};

const EXPECTATION_KEYS = ["scope", "domain", "allocationId", "valuationId", "questionId", "modelHash", "units", "spendId", "claimId", "checkerVersion", "executionVersion"] as const;

export function topicProbeExpectationKeys(expected: TopicProbeExpectation): readonly string[] {
  return [...EXPECTATION_KEYS, ...(expected.decisionBasisHash === undefined ? [] : ["decisionBasisHash"]),
    ...(expected.experimentBindingHash === undefined ? [] : ["experimentBindingHash"])];
}

/** Binding/shape check after trusted-host readback. A JSON claim alone never authenticates its source. */
export function readTopicProbeReceipt(json: string, ref: string, expected: TopicProbeExpectation): TopicProbeReceipt | undefined {
  if (expected.decisionBasisHash !== undefined && !/^[a-f0-9]{64}$/.test(expected.decisionBasisHash)) return undefined;
  if (expected.experimentBindingHash !== undefined && !/^[a-f0-9]{64}$/.test(expected.experimentBindingHash)) return undefined;
  return readBoundReceipt(json, ref, expected, topicProbeExpectationKeys(expected)) as TopicProbeReceipt | undefined;
}

export function readTopicCalibrationReceipt(json: string, ref: string, expected: TopicCalibrationExpectation): TopicCalibrationReceipt | undefined {
  const keys = ["scope", "domain", "allocationId", "valuationId", "units", "spendId", "claimId", "checkerVersion", "executionVersion", "purpose", "protocolHash"];
  const receipt = readBoundReceipt(json, ref, expected, keys);
  return receipt !== undefined && receipt.purpose === "calibration" && typeof receipt.protocolHash === "string"
    && /^[a-f0-9]{64}$/.test(receipt.protocolHash) ? receipt as TopicCalibrationReceipt : undefined;
}

function readBoundReceipt(json: string, ref: string, expected: TopicProbeExpectation | TopicCalibrationExpectation,
  keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof json !== "string" || json.length > 16384) return undefined;

  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return undefined; }

  if (!fields(raw, [...keys, "schemaVersion", "receiptRef", "sourceRef", "measurementHash", "outcome"])
    || raw.schemaVersion !== 1 || raw.receiptRef !== ref || !identity(raw.receiptRef) || !identity(raw.sourceRef)
    || !/^(execution|checker):/.test(raw.sourceRef) || typeof raw.measurementHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.measurementHash)
    || !sequence(raw.outcome) || raw.outcome > 7 || !keys.every(key => raw[key] === Reflect.get(expected, key))) return undefined;

  // The exact key/binding comparisons above allow this one boundary conversion, without granting execution rights.
  return raw;
}
