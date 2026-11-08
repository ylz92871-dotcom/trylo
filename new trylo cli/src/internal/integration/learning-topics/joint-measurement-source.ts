import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { readJointMeasurement, readJointOutcome, type JointOutcome, type TopicJointMeasurement } from "../../learning/domains/shared/topics/joint-empirical-model.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";

export type TopicJointNamespace = Pick<JointOutcome, "scope" | "protocolId" | "protocolVersion" | "conditionHash" | "utilityUnit">;

type Stored = Omit<Extract<TopicJointMeasurement, { readonly kind: "measured" }>, "sequence">
  | Omit<Extract<TopicJointMeasurement, { readonly kind: "unknown" }>, "sequence">;

export type TopicJointCaptureResult =
  | { readonly status: "recorded"; readonly measurement: TopicJointMeasurement; readonly revision: number; readonly idempotent: boolean }
  | { readonly status: "disabled" | "cancelled" | "stale" }
  | { readonly status: "unknown" | "rejected"; readonly reason: string };

const ALGORITHM = "ws1-joint-measurement-v1", MAX_NAMESPACE_RECORDS = 512, MAX_PAYLOAD_BYTES = 131072;
const NAMESPACE_KEYS = ["scope", "protocolId", "protocolVersion", "conditionHash", "utilityUnit"] as const;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const namespaceOf = (row: TopicJointNamespace): TopicJointNamespace => ({ scope: row.scope, protocolId: row.protocolId,
  protocolVersion: row.protocolVersion, conditionHash: row.conditionHash, utilityUnit: row.utilityUnit });
const sameNamespace = (a: TopicJointNamespace, b: TopicJointNamespace) => NAMESPACE_KEYS.every(key => a[key] === b[key]);
const jointId = (namespace: TopicJointNamespace, hostId: string) => `topic-joint:${contentHashOf([
  namespace.scope, namespace.protocolId, namespace.protocolVersion, namespace.conditionHash, namespace.utilityUnit, hostId])}`;
const corrupt = (): never => { throw new Error("topic_joint_measurement_corrupt"); };

/** The envelope makes raw host identities replayable without exposing another save API. */
function validEnvelope(measurement: TopicJointMeasurement): boolean {
  if (measurement.provenanceJson === undefined || !hash(measurement.provenanceHash)) return false;

  const raw: unknown = JSON.parse(measurement.provenanceJson);
  if (!fields(raw, ["schemaVersion", "type", "namespace", "hostMeasurementId", "hostSupersedes", "sourceProvenance"])
    || raw.schemaVersion !== 1 || raw.type !== "ws1_joint_measurement_provenance"
    || !identity(raw.hostMeasurementId) || (raw.hostSupersedes !== null && !identity(raw.hostSupersedes))
    || measurement.id !== jointId(measurement, raw.hostMeasurementId)
    || measurement.supersedes !== (raw.hostSupersedes === null ? undefined : jointId(measurement, raw.hostSupersedes))
    || contentHashOf(raw) !== measurement.provenanceHash) return false;

  const storedNamespace = raw.namespace;

  return fields(storedNamespace, NAMESPACE_KEYS) && NAMESPACE_KEYS.every(key => storedNamespace[key] === measurement[key]);
}

/** Strict scoped replay, including correction lineage; a missing or malformed episode is never a zero-valued sample. */
export function topicJointMeasurements(facts: readonly RewardV2Fact[], scope: string): TopicJointMeasurement[] {
  if (!identity(scope) || !Array.isArray(facts)) return corrupt();

  const result: TopicJointMeasurement[] = [], byId = new Map<string, TopicJointMeasurement>(), episodes = new Map<string, string>();
  const counts = new Map<string, number>();
  let previousSequence = 0;

  for (const fact of facts) {
    if (fact.scope !== scope || fact.algorithmVersion !== ALGORITHM) continue;

    if (fact.kind !== "feedback" || !identity(fact.id) || !sequence(fact.sequence) || fact.sequence <= previousSequence
      || typeof fact.payloadJson !== "string" || Buffer.byteLength(fact.payloadJson, "utf8") > MAX_PAYLOAD_BYTES) return corrupt();

    previousSequence = fact.sequence;
    const raw: unknown = JSON.parse(fact.payloadJson);
    if (!fields(raw, ["schemaVersion", "type", "measurement"]) || raw.schemaVersion !== 1 || raw.type !== "ws1_joint_measurement"
      || typeof raw.measurement !== "object" || raw.measurement === null || Array.isArray(raw.measurement)
      || Object.hasOwn(raw.measurement, "sequence")) return corrupt();

    const measurement = readJointMeasurement({ ...raw.measurement, sequence: fact.sequence });
    if (measurement === undefined || measurement.id !== fact.id || measurement.scope !== scope || byId.has(measurement.id)
      || !validEnvelope(measurement)) return corrupt();

    const namespace = canonicalJson(namespaceOf(measurement)), count = (counts.get(namespace) ?? 0) + 1;
    if (count > MAX_NAMESPACE_RECORDS) return corrupt();
    counts.set(namespace, count);
    const episode = canonicalJson([namespace, measurement.episodeId]), active = episodes.get(episode);

    if (measurement.supersedes === undefined) {
      if (active !== undefined) return corrupt();
    } else {
      const parent = byId.get(measurement.supersedes);
      if (parent === undefined || !sameNamespace(parent, measurement) || parent.episodeId !== measurement.episodeId
        || parent.sequence >= measurement.sequence || active !== parent.id) return corrupt();
    }

    episodes.set(episode, measurement.id);
    byId.set(measurement.id, measurement);
    result.push(measurement);
  }

  return result;
}

/**
 * read is a trusted host objective-checker/execution readback capability. Neither sourceRef
 * spelling nor a provenance hash authenticates data; the host must bind those references to
 * its actual immutable complete episode. Callers can request a ref, never submit raw values.
 */
export function createTopicJointMeasurementSource(options: {
  readonly boardRoot: string; readonly namespace: TopicJointNamespace; readonly enabled: () => boolean;
  readonly read: (ref: string, signal: AbortSignal) => Promise<JointOutcome | undefined>;
}) {
  const namespace = Object.freeze(namespaceOf(options.namespace)), enabled = options.enabled, read = options.read;
  if (![namespace.scope, namespace.protocolId, namespace.protocolVersion, namespace.utilityUnit].every(identity)
    || !hash(namespace.conditionHash) || typeof enabled !== "function" || typeof read !== "function") throw new Error("topic_joint_namespace_invalid");

  let suspended = false;
  const rejected = (reason: string): TopicJointCaptureResult => ({ status: "rejected", reason });
  const unknown = (reason: string): TopicJointCaptureResult => ({ status: "unknown", reason });

  function gate(signal: AbortSignal): TopicJointCaptureResult | undefined {
    return !enabled() ? { status: "disabled" } : signal.aborted ? { status: "cancelled" } : undefined;
  }

  async function capture(ref: string, signal: AbortSignal): Promise<TopicJointCaptureResult> {
    const stopped = gate(signal);
    if (stopped !== undefined) return stopped;

    if (suspended) return unknown("topic_joint_writer_suspended");

    if (!identity(ref)) return rejected("topic_joint_reference_invalid");

    let outcome: JointOutcome | undefined;

    try { outcome = readJointOutcome(await read(ref, signal)); }
    catch { return unknown("topic_joint_read_unconfirmed"); }

    const afterRead = gate(signal);
    if (afterRead !== undefined) return afterRead;

    if (outcome === undefined) return unknown("topic_joint_outcome_unconfirmed");

    if (!sameNamespace(namespace, outcome)) return rejected("topic_joint_namespace_mismatch");

    let measurement: Stored, payloadJson: string;

    try {
      const envelope = { schemaVersion: 1, type: "ws1_joint_measurement_provenance", namespace,
        hostMeasurementId: outcome.measurementId, hostSupersedes: outcome.supersedes ?? null,
        sourceProvenance: outcome.provenanceJson === undefined ? null : JSON.parse(outcome.provenanceJson) };
      const base = { ...namespace, id: jointId(namespace, outcome.measurementId), episodeId: outcome.episodeId, sourceRef: outcome.sourceRef,
        provenanceJson: canonicalJson(envelope), provenanceHash: contentHashOf(envelope),
        ...(outcome.supersedes === undefined ? {} : { supersedes: jointId(namespace, outcome.supersedes) }) };

      measurement = outcome.kind === "measured" ? { ...base, kind: "measured", observations: outcome.observations, actionUtilities: outcome.actionUtilities }
        : { ...base, kind: "unknown", reason: outcome.reason };

      if (readJointMeasurement({ ...measurement, sequence: 1 }) === undefined) return rejected("topic_joint_provenance_capacity");

      payloadJson = canonicalJson({ schemaVersion: 1, type: "ws1_joint_measurement", measurement });

      if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) return rejected("topic_joint_payload_capacity");
    } catch { return rejected("topic_joint_provenance_invalid"); }

    const board = createRewardV2BoardPort(options.boardRoot, () => enabled() && !signal.aborted);
    let prefix: Awaited<ReturnType<typeof board.read>>, rows: TopicJointMeasurement[];

    try {
      prefix = await board.read();
      rows = topicJointMeasurements(prefix.facts, namespace.scope);
    }
    catch { return gate(signal) ?? unknown("topic_joint_board_unconfirmed"); }

    const afterLoad = gate(signal);
    if (afterLoad !== undefined) return afterLoad;

    const previous = prefix.facts.find(row => row.id === measurement.id);
    if (previous !== undefined) {
      if (previous.scope !== namespace.scope || previous.algorithmVersion !== ALGORITHM || previous.kind !== "feedback" || previous.payloadJson !== payloadJson) {
        return rejected("topic_joint_measurement_conflict");
      }
      const stored = rows.find(row => row.id === measurement.id);
      return stored === undefined ? unknown("topic_joint_board_unconfirmed")
        : { status: "recorded", measurement: stored, revision: prefix.revision, idempotent: true };
    }

    const cohort = rows.filter(row => sameNamespace(namespace, row));
    if (cohort.length >= MAX_NAMESPACE_RECORDS) return rejected("topic_joint_record_capacity");

    if (measurement.supersedes === undefined) {
      if (cohort.some(row => row.episodeId === measurement.episodeId)) return rejected("topic_joint_episode_conflict");
    } else {
      const parent = cohort.find(row => row.id === measurement.supersedes);
      if (parent === undefined || parent.episodeId !== measurement.episodeId || cohort.some(row => row.supersedes === parent.id)) return rejected("topic_joint_correction_conflict");
    }

    const beforeWrite = gate(signal);
    if (beforeWrite !== undefined) return beforeWrite;

    try {
      const written = await board.append(prefix.revision, { id: measurement.id, scope: namespace.scope, algorithmVersion: ALGORITHM,
        kind: "feedback", payloadJson });
      if (written?.status === "stale") return { status: "stale" };

      if (written?.status !== "written" || gate(signal) !== undefined) {
        suspended = true;
        return unknown("topic_joint_write_unconfirmed");
      }

      const confirmed = await board.read(), stored = topicJointMeasurements(confirmed.facts, namespace.scope).find(row => row.id === measurement.id);
      const actual = confirmed.facts.find(row => row.id === measurement.id);
      if (stored === undefined || actual?.payloadJson !== payloadJson || gate(signal) !== undefined) {
        suspended = true;
        return unknown("topic_joint_write_unconfirmed");
      }

      return { status: "recorded", measurement: stored, revision: confirmed.revision, idempotent: written.idempotent };
    } catch {
      suspended = true;
      return unknown("topic_joint_write_unconfirmed");
    }
  }

  return Object.freeze({ capture, inspect: () => Object.freeze({ suspended }) });
}
