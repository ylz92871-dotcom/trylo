import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import type { GroundedLearningTopic, TopicExperimentDescriptor } from "../../learning/domains/shared/topics/contracts.js";
import { isTopicExperimentDescriptor } from "../../learning/domains/shared/topics/parse.js";
import { readTopicSubmission } from "../../learning/domains/shared/topics/submission.js";
import { readTopicExperimentBindingRecord, topicBindingMatchesSource, type TopicExperimentBinding, type TopicExperimentBindingRecord } from "../../learning/domains/shared/topics/experiment-binding.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { boundedOperation } from "../shared/bounded-operation.js";

export type TopicExperimentBindingReadback = {
  readonly topicId: string; readonly scope: string; readonly experimentRef: string; readonly experimentVersion: string;
  readonly conditionHash: string; readonly resolverVersion: string; readonly sourceRef: string;
};

/** Reads an already collected local host mapping; it starts no model, tool or approval operation. */
export type TopicExperimentBindingSource = {
  pending(): readonly string[];
  read(ref: string, signal: AbortSignal): Promise<TopicExperimentBindingReadback | undefined>;
};

export type TopicExperimentBindingCaptureResult =
  | { readonly status: "recorded" | "idempotent"; readonly binding: TopicExperimentBindingRecord }
  | { readonly status: "stale" | "disabled"; readonly reason?: string }
  | { readonly status: "unknown" | "rejected"; readonly reason: string };

type Candidate = { readonly fact: RewardV2Fact; readonly proposalJson: string; readonly windowJson: string; readonly topic: GroundedLearningTopic };

const ALGORITHM = "ws1-topic-binding-v1", MAX_BINDINGS = 512;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const corrupt = (): never => { throw new Error("topic_experiment_binding_corrupt"); };

function candidateOf(fact: RewardV2Fact, scope: string): Candidate | undefined {
  if (fact.scope !== scope || fact.kind !== "opportunity" || !sequence(fact.sequence) || fact.sequence < 1 || !identity(fact.algorithmVersion)) return undefined;

  const raw: unknown = JSON.parse(fact.payloadJson);
  if (!fields(raw, ["schemaVersion", "type", "proposal", "evidenceWindow"]) || raw.schemaVersion !== 1 || raw.type !== "ws1_topic_candidate") return undefined;

  if (fact.id !== `ws1:${contentHashOf({ scope, algorithmVersion: fact.algorithmVersion, payloadJson: fact.payloadJson })}`) return undefined;

  const proposalJson = canonicalJson(raw.proposal), windowJson = canonicalJson(raw.evidenceWindow), parsed = readTopicSubmission(proposalJson, windowJson);
  if (!parsed.ok || parsed.value.kind !== "topic" || parsed.value.topic.schemaVersion !== 2 || parsed.value.topic.scope !== scope
    || parsed.value.topic.basis.boardSequence >= fact.sequence) return undefined;

  return { fact, proposalJson, windowJson, topic: parsed.value.topic };
}

/** Strict replay of this relation algorithm. Older unrelated fact schemas remain untouched. */
export function topicExperimentBindings(facts: readonly RewardV2Fact[], scope: string): TopicExperimentBindingRecord[] {
  if (!identity(scope) || !Array.isArray(facts)) return corrupt();

  const result: TopicExperimentBindingRecord[] = [], topics = new Set<string>(), ids = new Set<string>();
  let previousSequence = 0;

  for (const fact of facts) {
    if (fact.scope !== scope || fact.algorithmVersion !== ALGORITHM) continue;

    if (fact.kind !== "learning_decision" || typeof fact.payloadJson !== "string" || fact.payloadJson.length > 8192) return corrupt();

    const raw: unknown = JSON.parse(fact.payloadJson);
    if (!fields(raw, ["schemaVersion", "type", "binding"]) || raw.schemaVersion !== 1 || raw.type !== "ws1_topic_experiment_binding") return corrupt();

    const record = readTopicExperimentBindingRecord({ id: fact.id, sequence: fact.sequence, binding: raw.binding });
    if (record === undefined || record.binding.scope !== scope || record.sequence <= previousSequence || ids.has(record.id)
      || topics.has(record.binding.topicId) || result.length >= MAX_BINDINGS) return corrupt();

    const sourceFact = facts.find(source => source.id === record.binding.sourceFactId);
    if (sourceFact === undefined || sourceFact.sequence > record.binding.bindingBoardSequence || sourceFact.sequence >= record.sequence) return corrupt();

    const candidate = candidateOf(sourceFact, scope);
    if (candidate === undefined || !topicBindingMatchesSource(record, candidate, record.sequence)) return corrupt();

    previousSequence = record.sequence;
    ids.add(record.id);
    topics.add(record.binding.topicId);
    result.push(record);
  }

  return result;
}

function readback(value: unknown): TopicExperimentBindingReadback | undefined {
  return fields(value, ["topicId", "scope", "experimentRef", "experimentVersion", "conditionHash", "resolverVersion", "sourceRef"])
    && [value.topicId, value.scope, value.experimentRef, value.experimentVersion, value.resolverVersion, value.sourceRef].every(identity)
    && hash(value.conditionHash) ? Object.freeze({ topicId: value.topicId as string, scope: value.scope as string,
      experimentRef: value.experimentRef as string, experimentVersion: value.experimentVersion as string,
      conditionHash: value.conditionHash, resolverVersion: value.resolverVersion as string, sourceRef: value.sourceRef as string }) : undefined;
}

/** The same Board owns this immutable relation; binding does not authorize the probe or create an execution job. */
export function createTopicExperimentBindingStore(options: {
  readonly boardRoot: string; readonly scope: string; readonly enabled: () => boolean;
  readonly source?: TopicExperimentBindingSource; readonly catalog: (facts: readonly RewardV2Fact[]) => readonly TopicExperimentDescriptor[];
}) {
  if (!identity(options.scope) || typeof options.enabled !== "function" || typeof options.catalog !== "function"
    || (options.source !== undefined && (typeof options.source.pending !== "function" || typeof options.source.read !== "function"))) throw new Error("topic_binding_store_configuration");

  const scope = options.scope, enabled = options.enabled, catalog = options.catalog, read = options.source?.read.bind(options.source);
  let suspended = false;
  const reject = (reason: string): TopicExperimentBindingCaptureResult => ({ status: "rejected", reason });
  const unknown = (reason: string): TopicExperimentBindingCaptureResult => ({ status: "unknown", reason });
  const gate = (signal: AbortSignal): TopicExperimentBindingCaptureResult | undefined => !enabled() ? { status: "disabled" }
    : signal.aborted ? { status: "disabled", reason: "topic_binding_cancelled" } : undefined;

  function approved(value: TopicExperimentBindingReadback, facts: readonly RewardV2Fact[]): TopicExperimentDescriptor | undefined {
    const entries = catalog(facts);
    if (!Array.isArray(entries) || entries.length > 64 || !entries.every(isTopicExperimentDescriptor)) throw new Error("topic_binding_catalog_invalid");
    const matches = entries.filter(entry => entry.ref === value.experimentRef && entry.version === value.experimentVersion && entry.conditionHash === value.conditionHash);
    return matches.length === 1 ? Object.freeze({ ...matches[0]! }) : undefined;
  }

  async function capture(ref: string, signal: AbortSignal): Promise<TopicExperimentBindingCaptureResult> {
    const stopped = gate(signal);
    if (stopped !== undefined) return stopped;

    if (suspended) return unknown("topic_binding_writer_suspended");

    if (read === undefined) return reject("topic_binding_source_unbound");

    if (!identity(ref)) return reject("topic_binding_reference_invalid");

    let resolved: TopicExperimentBindingReadback | undefined;

    try { resolved = readback(await boundedOperation(signal, 5000, bounded => read(ref, bounded), "topic_binding_read_timeout")); }
    catch { return unknown("topic_binding_read_unconfirmed"); }

    const afterRead = gate(signal);
    if (afterRead !== undefined) return afterRead;

    if (resolved === undefined) return unknown("topic_binding_read_unconfirmed");

    if (resolved.scope !== scope) return reject("topic_binding_scope_mismatch");

    const board = createRewardV2BoardPort(options.boardRoot, () => enabled() && !signal.aborted);
    let view: Awaited<ReturnType<typeof board.read>>, records: TopicExperimentBindingRecord[], candidate: Candidate, entry: TopicExperimentDescriptor;

    try {
      view = await board.read();
      records = topicExperimentBindings(view.facts, scope);
      const candidates = view.facts.flatMap(fact => {
        const source = candidateOf(fact, scope);
        return source?.topic.topicId === resolved!.topicId ? [source] : [];
      });
      if (candidates.length !== 1) return reject("topic_binding_candidate_not_unique");
      candidate = candidates[0]!;
    } catch { return gate(signal) ?? unknown("topic_binding_board_unconfirmed"); }

    const afterLoad = gate(signal);
    if (afterLoad !== undefined) return afterLoad;

    const existing = records.find(record => record.binding.topicId === resolved.topicId);

    // Display catalogs may temporarily hide an already-bound observation while advertising
    // the next missing one. Re-reading a known relation is not a new execution authorization.
    if (existing !== undefined) {
      const previous = existing.binding;
      return previous.sourceFactId === candidate.fact.id && previous.sourcePayloadHash === contentHashOf(JSON.parse(candidate.fact.payloadJson))
        && previous.experiment.ref === resolved.experimentRef && previous.experiment.version === resolved.experimentVersion
        && previous.experiment.conditionHash === resolved.conditionHash && previous.resolverVersion === resolved.resolverVersion
        && previous.sourceRef === resolved.sourceRef ? { status: "idempotent", binding: existing } : reject("topic_binding_conflict");
    }

    try {
      const current = approved(resolved, view.facts);
      if (current === undefined) return reject("topic_binding_experiment_unavailable");
      entry = current;
    } catch { return unknown("topic_binding_catalog_unconfirmed"); }

    const identityBody = { schemaVersion: 1 as const, sourceFactId: candidate.fact.id,
      sourcePayloadHash: contentHashOf(JSON.parse(candidate.fact.payloadJson)), topicId: candidate.topic.topicId, scope, domain: entry.domain,
      experiment: { ref: entry.ref, version: entry.version, conditionHash: resolved.conditionHash },
      resolverVersion: resolved.resolverVersion, sourceRef: resolved.sourceRef };

    if (records.length >= MAX_BINDINGS) return reject("topic_binding_capacity");

    const binding: TopicExperimentBinding = { ...identityBody, bindingBoardSequence: view.revision };
    const id = `topic-binding:${contentHashOf(binding)}`, payloadJson = canonicalJson({ schemaVersion: 1, type: "ws1_topic_experiment_binding", binding });
    if (readTopicExperimentBindingRecord({ id, sequence: view.revision + 1, binding }) === undefined) return reject("topic_binding_invalid");

    const beforeWrite = gate(signal);
    if (beforeWrite !== undefined) return beforeWrite;

    try {
      const current = approved(resolved, view.facts);
      if (current === undefined || canonicalJson([current.domain, current.ref, current.version, current.conditionHash])
        !== canonicalJson([entry.domain, entry.ref, entry.version, entry.conditionHash])) return { status: "stale", reason: "topic_binding_catalog_changed" };
    } catch { return unknown("topic_binding_catalog_unconfirmed"); }

    try {
      const written = await board.append(view.revision, { id, scope, algorithmVersion: ALGORITHM, kind: "learning_decision", payloadJson });
      if (written?.status === "stale") return { status: "stale" };
      if (written?.status !== "written" || gate(signal) !== undefined) {
        suspended = true;
        return unknown("topic_binding_write_unconfirmed");
      }
      const confirmed = await board.read(), saved = topicExperimentBindings(confirmed.facts, scope).find(record => record.id === id);
      if (saved === undefined || gate(signal) !== undefined) {
        suspended = true;
        return unknown("topic_binding_write_unconfirmed");
      }
      return { status: written.idempotent ? "idempotent" : "recorded", binding: saved };
    } catch {
      suspended = true;
      return unknown("topic_binding_write_unconfirmed");
    }
  }

  return Object.freeze({ capture, inspect: () => Object.freeze({ suspended }) });
}
