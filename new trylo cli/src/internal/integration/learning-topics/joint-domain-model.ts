import type { LearningDomain } from "../../learning/control/contracts.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { canonicalJson, contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import { readInformationModel, type InformationDecision } from "../../learning/domains/shared/topics/information-model.js";
import { buildJointEmpiricalModel, isJointEmpiricalPolicy, type JointEmpiricalPolicy,
  type JointObservation, type TopicJointMeasurement } from "../../learning/domains/shared/topics/joint-empirical-model.js";
import type { TopicExperimentDescriptor } from "../../learning/domains/shared/topics/contracts.js";
import { identity } from "../../validation/json-shape.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { topicJointMeasurements } from "./joint-measurement-source.js";
import type { TopicProbePort } from "./execution-contract.js";
import type { TopicDomainModelCandidate, TopicDomainModelProvenance, TopicDomainModelSource } from "./domain-model.js";
import { representTopicProvenanceValue } from "./provenance.js";
import { resolvedTopicExperiment, topicExperimentBindingHash } from "../../learning/domains/shared/topics/experiment-binding.js";

/** Identity of one immutable target/input version, matching the collector's episodeId. */
type Target = { readonly id: string; readonly sourceHash: string };

type QuestionBinding = { readonly experimentRef: string; readonly questionId: string };

export type JointDomainDecisionInput = {
  readonly boardSequence: number; readonly target: Target; readonly questions: readonly QuestionBinding[];
  readonly measurements: readonly TopicJointMeasurement[]; readonly facts: readonly RewardV2Fact[]; readonly signal: AbortSignal;
};

export type JointDomainDecisionResult =
  | { readonly status: "ready"; readonly decision: InformationDecision; readonly basisHash: string; readonly provenanceJson: string;
      readonly knownObservations?: readonly Pick<JointObservation, "experimentRef" | "experimentVersion" | "outcome" | "checkRef">[] }
  | { readonly status: "unmodelled"; readonly reason: string };

export type JointDomainModelOptions = {
  readonly boardRoot: string; readonly domain: LearningDomain; readonly policy: JointEmpiricalPolicy;
  readonly quotaUnit: string;
  readonly descriptors: readonly TopicExperimentDescriptor[];
  readonly checkerVersion: string; readonly executionVersion: string; readonly decisionVersion: string;
  readonly timeoutMs?: number; readonly enabled: () => boolean; readonly available: () => boolean;
  readonly currentTarget: () => Target | undefined;
  /** Pure replay of the real domain policy. It must not execute another experiment. */
  readonly decision: (input: JointDomainDecisionInput) => JointDomainDecisionResult | Promise<JointDomainDecisionResult>;
  readonly probe: TopicProbePort;
};

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function matchingTopic(candidate: TopicDomainModelCandidate, descriptor: TopicExperimentDescriptor, conditionHash: string): boolean {
  const experiment = resolvedTopicExperiment(candidate.topic, candidate.experimentBinding);
  return experiment !== undefined && experiment.domain === descriptor.domain && experiment.ref === descriptor.ref
    && experiment.version === descriptor.version && experiment.conditionHash === conditionHash;
}

/** A measurement-driven current-target model; it does not replace parameter-learning VOI with a diagnostic score. */
export function createJointEmpiricalDomainModelSource(options: JointDomainModelOptions): TopicDomainModelSource {
  if (!isJointEmpiricalPolicy(options.policy) || canonicalJson(options.policy).length > 12000
    || ![options.checkerVersion, options.executionVersion, options.decisionVersion, options.quotaUnit].every(identity)
    || typeof options.decision !== "function" || typeof options.probe.run !== "function" || typeof options.probe.readObservation !== "function") {
    throw new Error("topic_joint_source_configuration");
  }

  const policy: JointEmpiricalPolicy = Object.freeze({ ...options.policy, utilityBounds: Object.freeze({ ...options.policy.utilityBounds }),
    actions: Object.freeze([...options.policy.actions]), questions: Object.freeze(options.policy.questions.map(question => Object.freeze({ ...question, outcomes: Object.freeze([...question.outcomes]) }))) });
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || options.descriptors.length !== policy.questions.length) {
    throw new Error("topic_joint_source_configuration");
  }

  const descriptors = policy.questions.map(question => {
    const found = options.descriptors.filter(entry => entry.ref === question.experimentRef && entry.version === question.experimentVersion);
    if (found.length !== 1 || found[0]!.domain !== options.domain || typeof found[0]!.purpose !== "string"
      || !found[0]!.purpose.trim() || found[0]!.purpose.length > 160) throw new Error("topic_joint_source_catalog");
    return Object.freeze({ ref: found[0]!.ref, version: found[0]!.version, domain: found[0]!.domain, purpose: found[0]!.purpose });
  });
  const enabled = options.enabled.bind(options), available = options.available.bind(options), currentTarget = options.currentTarget.bind(options);
  const decide = options.decision.bind(options), run = options.probe.run.bind(options.probe), read = options.probe.readObservation.bind(options.probe);
  const versions = Object.freeze({ checkerVersion: options.checkerVersion, executionVersion: options.executionVersion });
  const domain = options.domain, quotaUnit = options.quotaUnit, decisionVersion = options.decisionVersion, probeBindingHash = contentHashOf(versions);
  const board = createRewardV2BoardPort(options.boardRoot, enabled);

  function target(): Target | undefined {
    if (!enabled() || !available()) return undefined;
    const value = currentTarget();
    return value !== undefined && identity(value.id) && hash(value.sourceHash) ? Object.freeze({ id: value.id, sourceHash: value.sourceHash }) : undefined;
  }

  const topicCondition = (value: Target) => contentHashOf({ protocolConditionHash: policy.conditionHash, target: value });

  return Object.freeze({ domain, utilityScale: policy.utilityScale,
    available: () => target() !== undefined,

    descriptors({ candidates }) {
      const current = target();
      if (current === undefined) return [];
      const conditionHash = topicCondition(current), catalog = descriptors.map(descriptor => Object.freeze({ ...descriptor, conditionHash }));
      const missing = catalog.filter(descriptor => !candidates.some(candidate => matchingTopic(candidate, descriptor, conditionHash)));
      return missing.length > 0 ? missing : catalog;
    },

    async prepare(request) {
      const captured = target();
      if (captured === undefined || request.signal.aborted || request.scope !== policy.scope) return undefined;

      const selected: TopicDomainModelCandidate[] = [];
      const questions: QuestionBinding[] = [];

      for (const descriptor of descriptors) {
        const candidates = request.candidates.filter(candidate => matchingTopic(candidate, descriptor, topicCondition(captured)))
          .sort((a, b) => b.topic.basis.boardSequence - a.topic.basis.boardSequence
            || (a.topic.topicId < b.topic.topicId ? -1 : a.topic.topicId > b.topic.topicId ? 1 : 0));
        if (candidates[0] !== undefined) {
          selected.push(candidates[0]);
          questions.push({ experimentRef: descriptor.ref, questionId: candidates[0].topic.topicId });
        }
      }

      if (selected.length === 0) return undefined;

      const view = await board.read();
      if (!enabled() || request.signal.aborted || view.revision !== request.boardSequence) return undefined;

      const measurements = topicJointMeasurements(view.facts, policy.scope).filter(row => row.protocolId === policy.protocolId
        && row.protocolVersion === policy.protocolVersion && row.conditionHash === policy.conditionHash && row.utilityUnit === policy.utilityUnit);

      // A complete target is already known; an unknown target record is not permission to repeat it.
      if (measurements.some(row => row.episodeId === captured.id)) return undefined;

      const projected = await decide({ boardSequence: view.revision, target: captured, questions,
        measurements: Object.freeze(measurements), facts: view.facts, signal: request.signal });
      const sameTarget = () => {
        const value = target();
        return value !== undefined && value.id === captured.id && value.sourceHash === captured.sourceHash;
      };
      if (!enabled() || request.signal.aborted || !sameTarget()
        || projected.status !== "ready" || !hash(projected.basisHash) || typeof projected.provenanceJson !== "string"
        || projected.provenanceJson.length > 262144) return undefined;

      const model = buildJointEmpiricalModel({ policy, boardSequence: view.revision, measurements, questions, decision: projected.decision,
        ...(projected.knownObservations === undefined ? {} : { knownObservations: projected.knownObservations }) });
      if (model.status !== "ready") return undefined;

      const parsed = readInformationModel(model.modelJson);
      if (!parsed.ok) return undefined;

      const parsedModel = parsed.model, modelIds = new Set(parsedModel.questions.map(question => question.id));
      const pending = selected.filter(candidate => modelIds.has(candidate.topic.topicId));
      if (pending.length === 0) return undefined;

      const provenance: TopicDomainModelProvenance = { schemaVersion: 1, type: "ws1_topic_domain_model", scope: policy.scope,
        domain, boardSequence: view.revision, utilityUnit: policy.utilityUnit, quotaUnit,
        modelHash: contentHashOf(parsedModel), domainDecisionHash: projected.basisHash, probeBindingHash,
        ...versions, timeoutMs, candidates: pending.map(candidate => ({ topicId: candidate.topic.topicId,
          proposalSha256: sha256Hex(candidate.proposalJson), windowSha256: sha256Hex(candidate.windowJson),
          ...(candidate.experimentBinding === undefined ? {} : { experimentBindingHash: topicExperimentBindingHash(candidate.experimentBinding) }) })),
        source: { algorithmVersion: model.provenance.estimator, recordRefs: model.provenance.supportIds.slice(0, 8), recordDigest: model.provenance.supportHash,
          assumptions: model.provenance.assumptions, target: captured, policy, decisionVersion,
          knownObservations: projected.knownObservations ?? [],
          decisionSource: representTopicProvenanceValue(JSON.parse(projected.provenanceJson)),
          support: { representation: "board_prefix_digest", count: model.provenance.supportIds.length,
            idsHash: contentHashOf(model.provenance.supportIds), stateCounts: model.provenance.stateCounts,
            observationVectorsHash: contentHashOf(model.provenance.observationVectors) },
          selection: { sameNamespace: true, throughSequence: view.revision, excludedEpisodeId: captured.id } } };
      const stillCurrent = () => enabled() && !request.signal.aborted && sameTarget();
      const probe: TopicProbePort = Object.freeze({
        async run(input) {
          if (!stillCurrent() || input.signal.aborted || input.decisionBasisHash !== projected.basisHash) throw new Error("topic_joint_target_changed");
          return run(input);
        },

        async readObservation(ref, expected, signal) {
          if (!stillCurrent() || signal.aborted || expected.decisionBasisHash !== projected.basisHash) throw new Error("topic_joint_target_changed");
          const result = await read(ref, expected, signal);
          if (!stillCurrent() || signal.aborted) throw new Error("topic_joint_target_changed");
          return result;
        } });

      return { input: { candidates: pending.map(candidate => ({ proposalJson: candidate.proposalJson, windowJson: candidate.windowJson,
        ...(candidate.experimentBinding === undefined ? {} : { experimentBinding: candidate.experimentBinding }) })),
        modelJson: model.modelJson, utilityUnit: policy.utilityUnit, quotaUnit: provenance.quotaUnit,
        maxQuota: request.maxQuota, valuationBoardSequence: view.revision, domainDecisionHash: projected.basisHash,
        probeBindingHash, modelProvenanceJson: canonicalJson(provenance), modelProvenanceHash: contentHashOf(provenance) }, probe, ...versions, timeoutMs };
    } });
}
