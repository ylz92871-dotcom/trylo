import type { ReadRoutingConditions } from "../../../../../../ports/read-routing.js";
import type { BoardState } from "../../../../../control/state.js";
import type { TopicPairedMeasurement } from "../../../../../domains/shared/topics/empirical-model.js";
import { canonicalJson, contentHashOf } from "../../../../../control/hash.js";
import { rewardRecordsOf } from "../../../../../control/reward-records.js";
import { readStrategyEnvironment, readStrategyCost } from "../domain/index.js";
import { activeReadStrategyFeedback, readStrategyObservations } from "../domain/observations.js";
import { readStrategyBoard } from "../runtime/archive.js";
import { readStrategyConditions } from "../runtime/sensor.js";
import { topicMeasurements, type TopicPairedOutcome } from "../../../../../../integration/learning-topics/experiment-port.js";
import { readScenarioOf, readSelectedAction } from "./read-decision.js";
import { readPairUtility, readPairStudyCost } from "./read-objective.js";

function storedHostId(row: TopicPairedMeasurement): string | undefined {
  if (row.provenanceJson === undefined || row.provenanceJson.length > 16384) return undefined;

  const provenance: unknown = JSON.parse(row.provenanceJson);
  if (typeof provenance !== "object" || provenance === null || row.sourceRef !== `checker:${contentHashOf(provenance)}`) return undefined;

  const revision: unknown = Reflect.get(provenance, "feedbackRevision"), expectedHash: unknown = Reflect.get(provenance, "expectedHash");
  const hostId: unknown = typeof revision === "object" && revision !== null ? Reflect.get(revision, "hostMeasurementId")
    : typeof expectedHash === "string" && /^[a-f0-9]{64}$/.test(expectedHash) ? `read-pair:${expectedHash}` : undefined;
  if (typeof hostId !== "string" || !/^read-pair(?:-revision)?:[a-f0-9]{64}$/.test(hostId)) return undefined;

  return row.id === `topic-measure:${contentHashOf([row.scope, row.experimentRef, row.experimentVersion, row.conditionHash, hostId])}` ? hostId : undefined;
}

function storedOutcome(row: TopicPairedMeasurement, rows: readonly TopicPairedMeasurement[]): TopicPairedOutcome | undefined {
  const measurementId = storedHostId(row);
  const previous = row.supersedes === undefined ? undefined : rows.find(item => item.id === row.supersedes);
  const supersedes = previous === undefined ? undefined : storedHostId(previous);
  if (measurementId === undefined || (row.supersedes !== undefined && supersedes === undefined)) return undefined;

  const base = { scope: row.scope, experimentRef: row.experimentRef, experimentVersion: row.experimentVersion,
    conditionHash: row.conditionHash, utilityUnit: row.utilityUnit, measurementId, sourceRef: row.sourceRef,
    ...(row.provenanceJson === undefined ? {} : { provenanceJson: row.provenanceJson }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(row.deploymentAction === undefined ? {} : { deploymentAction: row.deploymentAction }),
    ...(row.decisionBasisHash === undefined ? {} : { decisionBasisHash: row.decisionBasisHash }) };

  return row.kind === "measured" ? Object.freeze({ ...base, kind: "measured", baselineUtility: row.baselineUtility,
    candidateUtility: row.candidateUtility, fullStudyCost: row.fullStudyCost }) : Object.freeze({ ...base, kind: "unknown", reason: row.reason });
}

export type ReadTopicFeedbackOptions = { readonly boardRoot: string; readonly scope: string;
  readonly experimentRef: string; readonly experimentVersion: string; readonly utilityUnit: string;
  readonly enabled: () => boolean };

type Derived = { readonly outcome: TopicPairedOutcome; readonly changed: boolean };

const validRef = (ref: string) => /^(?:topic-measure|checker|read-pair|read-pair-revision|read-topic-pair):[a-f0-9]{64}$/.test(ref);

function matchesRef(row: TopicPairedMeasurement, ref: string): boolean {
  if (row.id === ref || row.sourceRef === ref || storedHostId(row) === ref) return true;

  if (!ref.startsWith("read-topic-pair:") || row.provenanceJson === undefined) return false;

  const raw: unknown = JSON.parse(row.provenanceJson);
  if (typeof raw !== "object" || raw === null) return false;

  const opportunity: unknown = Reflect.get(raw, "opportunity"), expectedHash: unknown = Reflect.get(raw, "expectedHash");

  return typeof opportunity === "object" && opportunity !== null && typeof expectedHash === "string"
    && ref === `read-topic-pair:${contentHashOf([expectedHash, Reflect.get(opportunity, "executionId")])}`;
}

/** Pure derivation from one immutable Board snapshot; no execution, persistence or IO. */
function deriveFeedback(state: BoardState, rows: readonly TopicPairedMeasurement[], options: ReadTopicFeedbackOptions, ref: string): Derived | undefined {
  if (!validRef(ref)) return undefined;
  try {
    const matches = rows.filter(row => matchesRef(row, ref));

    // A run reference may match its revisions too; all matches must be on one unbranched chain.
    if (matches.length === 0) return undefined;

    let current = matches.reduce((a, b) => a.sequence < b.sequence ? a : b);
    const visited = new Set<string>();

    while (true) {
      if (visited.has(current.id)) return undefined;

      visited.add(current.id);
      const next = rows.filter(row => row.supersedes === current.id);
      if (next.length > 1) return undefined;

      if (next.length === 0) break;

      if (next[0]!.sequence <= current.sequence) return undefined;

      current = next[0]!;
    }

    const chain = new Set<string>([current.id]);
    let original = current;

    while (original.supersedes !== undefined) {
      const previous = rows.find(row => row.id === original.supersedes);
      if (previous === undefined || chain.has(previous.id) || previous.sequence >= original.sequence) return undefined;
      chain.add(previous.id);
      original = previous;
    }

    if (matches.some(row => !chain.has(row.id))) return undefined;

    const unchanged = storedOutcome(current, rows);
    if (unchanged === undefined) return undefined;

    if (original.kind !== "measured" || original.provenanceJson === undefined) return { outcome: unchanged, changed: false };

    const provenance: unknown = JSON.parse(original.provenanceJson);
    if (typeof provenance !== "object" || provenance === null) return undefined;

    const opportunity: unknown = Reflect.get(provenance, "opportunity"), rawArms: unknown = Reflect.get(provenance, "arms");
    if (typeof opportunity !== "object" || opportunity === null || !Array.isArray(rawArms) || rawArms.length !== 2) return undefined;

    const rawConditions: unknown = Reflect.get(opportunity, "conditions");
    if (typeof rawConditions !== "object" || rawConditions === null) return undefined;

    const conditions = rawConditions as ReadRoutingConditions, scenario = readScenarioOf(original, conditions);
    if (scenario === undefined) return undefined;

    if (current.kind === "measured" && readScenarioOf(current, conditions) === undefined) return undefined;

    const records = rewardRecordsOf(state), observations = readStrategyObservations(records, options.scope),
      active = activeReadStrategyFeedback(records).filter(row => row.origin !== "model");
    const checks: { readonly executionId: string; readonly exposureId: string | null; readonly quality: "pass" | "fail" | "unknown";
      readonly selectedFeedbackId: string | null; readonly activeFeedbackIds: readonly string[]; readonly activeFeedbackHash: string }[] = [];
    const revisedArms: unknown[] = [];
    let initialChecks = true;

    for (const [index, physical] of scenario.arms.entries()) {
      const raw: unknown = rawArms[index], routing: unknown = typeof raw === "object" && raw !== null ? Reflect.get(raw, "routing") : undefined;
      const executionId: unknown = typeof routing === "object" && routing !== null ? Reflect.get(routing, "executionId") : undefined;
      if (typeof executionId !== "string" || !/^read-topic-trial:[a-f0-9]{64}$/.test(executionId)) return undefined;

      const found = observations.filter(row => row.exposure.source.eventId === executionId && row.path === physical.path
        && readStrategyEnvironment(row.conditions) === readStrategyEnvironment(readStrategyConditions(conditions)));
      if (found.length > 1) return undefined;

      const observation = found[0], exposureId = observation?.exposure.id;
      const feedbacks = exposureId === undefined ? [] : active.filter(row => row.exposureId === exposureId).sort((a, b) => a.id.localeCompare(b.id));
      const originalCheck = records.feedbacks.find(row => row.id === `${executionId}:checked` && row.exposureId === exposureId);
      const automatic = records.feedbacks.find(row => row.id === `${exposureId}:result` && row.exposureId === exposureId);
      const physicalCost = readStrategyCost(physical.quality === "fail" ? "failed" : "completed", physical.bytesRead, physical.latencyMs);
      const originalBound = originalCheck !== undefined && originalCheck.origin !== "model" && originalCheck.evidenceIds.includes(physical.proofRef)
        && originalCheck.evidenceIds.includes(`tool-read:${physical.quality === "pass" ? "verified" : "failed"}:${executionId}`)
        && automatic?.outcome.kind === "measured" && automatic.outcome.value === physicalCost;
      const quality = !originalBound ? "unknown" : observation?.quality === "verified" ? "pass" : observation?.quality === "failed" ? "fail" : "unknown";
      if (feedbacks.length !== 1 || feedbacks[0]?.id !== `${executionId}:checked` || quality !== physical.quality) initialChecks = false;

      checks.push({ executionId, exposureId: exposureId ?? null, quality, selectedFeedbackId: observation?.feedback?.id ?? null,
        activeFeedbackIds: feedbacks.map(row => row.id), activeFeedbackHash: contentHashOf(feedbacks) });
      revisedArms.push({ path: physical.path, result: { path: physical.path, quality, executed: true,
        bytesRead: physical.bytesRead, latencyMs: physical.latencyMs, totalBytesRead: physical.totalBytesRead,
        totalLatencyMs: physical.totalLatencyMs, proofRef: physical.proofRef },
        routing: { executionId, state: quality === "unknown" ? "unconfirmed" : "confirmed" } });
    }

    const feedbackStateHash = contentHashOf({ originalMeasurementId: original.id, checks });
    const currentProvenance: unknown = current.provenanceJson === undefined ? undefined : JSON.parse(current.provenanceJson);
    const currentRevision: unknown = typeof currentProvenance === "object" && currentProvenance !== null ? Reflect.get(currentProvenance, "feedbackRevision") : undefined;
    if ((current.id === original.id && initialChecks) || (typeof currentRevision === "object" && currentRevision !== null
      && Reflect.get(currentRevision, "feedbackStateHash") === feedbackStateHash)) return { outcome: unchanged, changed: false };

    const supersedes = storedHostId(current), originalHostMeasurementId = storedHostId(original);
    if (supersedes === undefined || originalHostMeasurementId === undefined) return undefined;

    const measurementId = `read-pair-revision:${contentHashOf([originalHostMeasurementId, current.id, feedbackStateHash])}`;
    const currentAction = readSelectedAction(state, options.scope, conditions);
    const revisedProvenance = { ...provenance, arms: revisedArms,
      feedbackRevision: { schemaVersion: 1, hostMeasurementId: measurementId, supersedesHostMeasurementId: supersedes,
        originalHostMeasurementId, originalSourceRef: original.sourceRef, previousSourceRef: current.sourceRef,
        feedbackStateHash, checks, physicalExecutionBytesUnchanged: true,
        history: { deploymentAction: original.deploymentAction ?? null, decisionBasisHash: original.decisionBasisHash ?? null },
        current: { deploymentAction: currentAction, selectorOnly: true },
        interpretation: "Historical pair with current active external checks; current selector action is not its historical successor" } };
    const provenanceJson = canonicalJson(revisedProvenance);
    if (provenanceJson.length > 16384) return undefined;

    const base = { scope: original.scope, experimentRef: original.experimentRef, experimentVersion: original.experimentVersion,
      conditionHash: original.conditionHash, utilityUnit: original.utilityUnit, measurementId, supersedes,
      sourceRef: `checker:${contentHashOf(revisedProvenance)}`, provenanceJson,
      ...(original.deploymentAction === undefined ? {} : { deploymentAction: original.deploymentAction }),
      ...(original.decisionBasisHash === undefined ? {} : { decisionBasisHash: original.decisionBasisHash }) };

    if (checks.some(row => row.quality === "unknown")) return { changed: true,
      outcome: Object.freeze({ ...base, kind: "unknown", reason: "read_topic_feedback_unknown" }) };

    const utility = (index: number) => readPairUtility(checks[index]!.quality === "pass" ? "pass" : "fail",
      scenario.arms[index]!.bytesRead, scenario.arms[index]!.latencyMs);
    const fullStudyCost = scenario.arms.reduce((sum, arm) => sum + readPairStudyCost(arm.totalBytesRead, arm.totalLatencyMs), 0);

    return { changed: true, outcome: Object.freeze({ ...base, kind: "measured", baselineUtility: utility(0), candidateUtility: utility(1), fullStudyCost }) };
  } catch { return undefined; }
}

async function snapshot(options: ReadTopicFeedbackOptions, signal: AbortSignal) {
  if (!options.enabled() || signal.aborted) return undefined;
  const state = await readStrategyBoard(options.boardRoot);
  if (!options.enabled() || signal.aborted) return undefined;
  const rows = topicMeasurements(state.rewardV2Facts ?? [], options.scope).filter(row => row.experimentRef === options.experimentRef
    && row.experimentVersion === options.experimentVersion && row.utilityUnit === options.utilityUnit);
  return { state, rows };
}

/** Returns the unchanged original outcome too, so single-ref callers retain durable idempotence. */
export async function readReadTopicFeedback(options: ReadTopicFeedbackOptions, ref: string, signal: AbortSignal): Promise<TopicPairedOutcome | undefined> {
  if (!validRef(ref)) return undefined;
  try {
    const view = await snapshot(options, signal);
    if (view === undefined) return undefined;
    const derived = deriveFeedback(view.state, view.rows, options, ref);
    return !options.enabled() || signal.aborted ? undefined : derived?.outcome;
  } catch { return undefined; }
}

/** One Board read for every ref. Only changed outcomes are emitted; unknown refs are skipped. */
export async function readReadTopicFeedbackBatch(options: ReadTopicFeedbackOptions, refs: readonly string[], signal: AbortSignal): Promise<readonly TopicPairedOutcome[]> {
  if (!options.enabled() || signal.aborted) return Object.freeze([]);

  if (!Array.isArray(refs) || refs.length > 512) throw new Error("read_topic_feedback_unconfirmed");

  const valid = [...new Set(refs.filter(ref => typeof ref === "string" && validRef(ref)))];
  if (valid.length === 0) return Object.freeze([]);

  const view = await snapshot(options, signal);
  if (view === undefined) return Object.freeze([]);

  const seen = new Set<string>(), result: TopicPairedOutcome[] = [];

  for (const ref of valid) {
    if (!options.enabled() || signal.aborted) return Object.freeze([]);

    const known = view.rows.some(row => matchesRef(row, ref));
    const derived = deriveFeedback(view.state, view.rows, options, ref);
    if (known && derived === undefined) throw new Error("read_topic_feedback_unconfirmed");

    if (derived?.changed && !seen.has(derived.outcome.measurementId)) {
      seen.add(derived.outcome.measurementId);
      result.push(derived.outcome);
    }
  }

  return !options.enabled() || signal.aborted ? Object.freeze([]) : Object.freeze(result);
}

