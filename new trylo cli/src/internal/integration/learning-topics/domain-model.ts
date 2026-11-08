import { LEARNING_DOMAINS, type LearningDomain } from "../../learning/control/contracts.js";
import { canonicalJson, contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import type { GroundedLearningTopic, TopicExperimentDescriptor } from "../../learning/domains/shared/topics/contracts.js";
import { INFORMATION_LIMITS, readInformationModel } from "../../learning/domains/shared/topics/information-model.js";
import { prepareTopicOpportunity, type TopicOpportunity } from "../../learning/domains/shared/topics/opportunity.js";
import { freezeTopicOpportunityInput, readTopicOpportunitySources,
  type TopicOpportunityCandidate } from "../../learning/domains/shared/topics/opportunity-input.js";
import { topicExperimentBindingHash } from "../../learning/domains/shared/topics/experiment-binding.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import type { PreparedTopicDomain } from "./domain-runtime.js";

/** Rebuilt by the host from its real Board candidate fact, preserving both original strings. */
export type TopicDomainModelCandidate = TopicOpportunityCandidate & { readonly topic: GroundedLearningTopic };

export type TopicDomainModelRequest = {
  readonly scope: string; readonly boardSequence: number; readonly maxQuota: number;
  readonly candidates: readonly TopicDomainModelCandidate[]; readonly signal: AbortSignal;
};

/** Trusted local construction of a joint finite model. This port confers no execution permission. */
export type TopicDomainModelSource = {
  readonly domain: LearningDomain;
  /** Required when this source normalizes raw measurements before quoting a common unit. */
  readonly utilityScale?: number;
  available(): boolean;
  /** The domain advertises its own approved observations, prioritizing questions it still lacks. */
  descriptors?(input: { readonly candidates: readonly TopicDomainModelCandidate[] }): readonly TopicExperimentDescriptor[];
  prepare(request: TopicDomainModelRequest): PreparedTopicDomain | undefined | Promise<PreparedTopicDomain | undefined>;
};

export type TopicDomainModelValidationRequest = Omit<TopicDomainModelRequest, "candidates"> & {
  readonly domain: LearningDomain; readonly utilityUnit: string; readonly quotaUnit: string;
};

/**
 * Replay identity for a host-owned joint model. modelHash hashes the parsed finite model;
 * proposal/window hashes hash the exact original UTF-8 strings, in the selected input order.
 * recordRefs and recordDigest must identify the owner's immutable supporting records at
 * boardSequence. The owner must reproduce its parameters, actual deployment-state mapping,
 * units and assumptions from those records/its versioned algorithm. These checks establish
 * bindings, not the truth of source assertions, likelihood calibration or exchangeability.
 */
export type TopicDomainModelProvenance = {
  readonly schemaVersion: 1; readonly type: "ws1_topic_domain_model";
  readonly scope: string; readonly domain: LearningDomain; readonly boardSequence: number;
  readonly utilityUnit: string; readonly quotaUnit: string; readonly modelHash: string;
  readonly domainDecisionHash: string; readonly probeBindingHash: string;
  readonly checkerVersion: string; readonly executionVersion: string; readonly timeoutMs: number;
  readonly candidates: readonly { readonly topicId: string; readonly proposalSha256: string; readonly windowSha256: string;
    readonly experimentBindingHash?: string }[];
  readonly source: {
    readonly algorithmVersion: string; readonly recordRefs: readonly string[]; readonly recordDigest: string;
    readonly assumptions: readonly string[];
    /** Optional replayable parameters/algorithm-specific metadata; never an authorization. */
    readonly [key: string]: unknown;
  };
};

type Failure = "topic_domain_model_cancelled" | "topic_domain_model_owner" | "topic_domain_model_budget"
  | "topic_domain_model_candidates" | "topic_domain_model_schema" | "topic_domain_model_provenance"
  | "topic_domain_model_probe" | "topic_domain_model_unvalued" | "topic_domain_model_planning_limit"
  | Extract<TopicOpportunity, { readonly status: "rejected" }>["reason"];

export type TopicDomainModelValidation =
  | { readonly ok: true; readonly prepared: PreparedTopicDomain;
      readonly opportunity: Extract<TopicOpportunity, { readonly status: "offered" }> }
  | { readonly ok: false; readonly reason: Failure };

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const reject = (reason: Failure): TopicDomainModelValidation => ({ ok: false, reason });

function validProvenance(prepared: PreparedTopicDomain, request: TopicDomainModelValidationRequest,
  bindings: TopicDomainModelProvenance["candidates"], modelHash: string, timeoutMs: number): boolean {
  const input = prepared.input;
  if (typeof input.modelProvenanceJson !== "string" || input.modelProvenanceJson.length > 32768
    || !hash(input.modelProvenanceHash)) return false;

  const raw: unknown = JSON.parse(input.modelProvenanceJson);
  if (!fields(raw, ["schemaVersion", "type", "scope", "domain", "boardSequence", "utilityUnit", "quotaUnit", "modelHash",
    "domainDecisionHash", "probeBindingHash", "checkerVersion", "executionVersion", "timeoutMs", "candidates", "source"])
    || raw.schemaVersion !== 1 || raw.type !== "ws1_topic_domain_model" || raw.scope !== request.scope || raw.domain !== request.domain
    || raw.boardSequence !== request.boardSequence || raw.utilityUnit !== request.utilityUnit || raw.quotaUnit !== request.quotaUnit
    || raw.modelHash !== modelHash || raw.domainDecisionHash !== input.domainDecisionHash || raw.probeBindingHash !== input.probeBindingHash
    || raw.checkerVersion !== prepared.checkerVersion || raw.executionVersion !== prepared.executionVersion || raw.timeoutMs !== timeoutMs
    || canonicalJson(raw.candidates) !== canonicalJson(bindings) || contentHashOf(raw) !== input.modelProvenanceHash) return false;

  const source = raw.source;

  return typeof source === "object" && source !== null && !Array.isArray(source)
    && identity(Reflect.get(source, "algorithmVersion")) && hash(Reflect.get(source, "recordDigest"))
    && Array.isArray(Reflect.get(source, "recordRefs")) && Reflect.get(source, "recordRefs").length <= 512
    && Reflect.get(source, "recordRefs").every(identity)
    && Array.isArray(Reflect.get(source, "assumptions")) && Reflect.get(source, "assumptions").length > 0
    && Reflect.get(source, "assumptions").length <= 64
    && Reflect.get(source, "assumptions").every((item: unknown) => typeof item === "string" && item.trim().length > 0 && item.length <= 1024);
}

/** Local admission/quotation only. Uses the shared grounding/model validators and never invokes a probe or Board writer. */
export function validatePreparedDomainModel(prepared: PreparedTopicDomain, request: TopicDomainModelValidationRequest,
  sourceCandidates: readonly TopicDomainModelCandidate[]): TopicDomainModelValidation {
  try {
    if (request.signal.aborted) return reject("topic_domain_model_cancelled");

    if (!LEARNING_DOMAINS.includes(request.domain) || ![request.scope, request.utilityUnit, request.quotaUnit].every(identity)) return reject("topic_domain_model_owner");

    if (!sequence(request.boardSequence) || !sequence(request.maxQuota) || request.maxQuota > INFORMATION_LIMITS.quota
      || !Array.isArray(sourceCandidates) || sourceCandidates.length > 512) return reject("topic_domain_model_budget");

    if (prepared === null || typeof prepared !== "object" || prepared.input === null || typeof prepared.input !== "object") return reject("topic_domain_model_schema");

    const input = prepared.input, timeoutMs = prepared.timeoutMs ?? 5000;
    if (input.valuationBoardSequence !== request.boardSequence || input.utilityUnit !== request.utilityUnit
      || input.quotaUnit !== request.quotaUnit || input.maxQuota !== request.maxQuota) return reject("topic_domain_model_owner");

    if (!identity(prepared.checkerVersion) || !identity(prepared.executionVersion) || !sequence(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
      || !hash(input.domainDecisionHash) || input.probeBindingHash !== contentHashOf({ checkerVersion: prepared.checkerVersion, executionVersion: prepared.executionVersion })
      || typeof prepared.probe?.run !== "function" || typeof prepared.probe.readObservation !== "function") return reject("topic_domain_model_probe");

    const sources = readTopicOpportunitySources(input);
    if (sources.status !== "ready") return reject(sources.reason);

    if (sources.candidates.length === 0 || sources.topics.size !== sources.candidates.length || sources.boardSequence !== request.boardSequence
      || sources.domain !== request.domain) return reject("topic_domain_model_candidates");

    const bindings: { readonly topicId: string; readonly proposalSha256: string; readonly windowSha256: string; readonly experimentBindingHash?: string }[] = [];

    for (const candidate of sources.candidates) {
      const topic = candidate.topic;
      if (topic === null || topic.scope !== request.scope || candidate.window.scope !== request.scope
        || candidate.window.boardSequence > request.boardSequence || topic.basis.boardSequence !== candidate.window.boardSequence) return reject("topic_domain_model_owner");

      const original = sourceCandidates.find(source => source.proposalJson === candidate.proposalJson && source.windowJson === candidate.windowJson
        && canonicalJson(source.topic) === canonicalJson(topic)
        && canonicalJson(source.experimentBinding ?? null) === canonicalJson(candidate.experimentBinding ?? null));
      if (original === undefined) return reject("topic_domain_model_candidates");

      bindings.push(Object.freeze({ topicId: topic.topicId, proposalSha256: sha256Hex(candidate.proposalJson), windowSha256: sha256Hex(candidate.windowJson),
        ...(candidate.experimentBinding === undefined ? {} : { experimentBindingHash: topicExperimentBindingHash(candidate.experimentBinding) }) }));
    }

    if (input.modelJson === null) return reject("topic_domain_model_unvalued");

    const model = readInformationModel(input.modelJson);
    if (!model.ok) return reject(model.reason);

    if (model.model.schemaVersion !== 2 || model.model.questions.length !== sources.topics.size
      || model.model.questions.some(question => !sources.topics.has(question.id))) return reject("topic_domain_model_schema");

    if (!validProvenance(prepared, request, bindings, contentHashOf(model.model), timeoutMs)) return reject("topic_domain_model_provenance");

    const frozenInput = freezeTopicOpportunityInput(input);
    if (frozenInput === undefined) return reject("topic_domain_model_candidates");

    const offer = prepareTopicOpportunity(frozenInput);

    if (request.signal.aborted) return reject("topic_domain_model_cancelled");

    if (offer.status === "rejected") return reject(offer.reason);

    if (offer.status === "planning_limit") return reject("topic_domain_model_planning_limit");

    if (offer.status !== "offered") return reject("topic_domain_model_unvalued");

    if (offer.bid.domain !== request.domain || offer.bid.scope !== request.scope || offer.bid.basis.boardSequence !== request.boardSequence
      || offer.bid.utilityUnit !== request.utilityUnit || offer.bid.quotaUnit !== request.quotaUnit) return reject("topic_domain_model_owner");

    const probe = Object.freeze({ run: prepared.probe.run.bind(prepared.probe), readObservation: prepared.probe.readObservation.bind(prepared.probe) });

    return Object.freeze({ ok: true, opportunity: offer, prepared: Object.freeze({ input: frozenInput, probe,
      checkerVersion: prepared.checkerVersion, executionVersion: prepared.executionVersion, timeoutMs }) });
  } catch { return reject("topic_domain_model_schema"); }
}
