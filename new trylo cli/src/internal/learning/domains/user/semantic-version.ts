import { sha256Hex, shortId } from "../shared/hash.js";
import { type ConclusionRecord, type UserEvidence, type UserModelRecord } from "./contracts.js";
import type { UserLearningVersion } from "./learning-cycle-contract.js";
import type { UserSemanticDraft } from "./semantic-draft.js";
import { classifySemanticUserEligibility, safeUserPolicyInstruction } from "./semantic-eligibility.js";
import { classifyInferenceDistance } from "./user-model.js";

type Input = { readonly draft: UserSemanticDraft; readonly evidence: readonly UserEvidence[]; readonly userId: string;
  readonly scopeFingerprint: string; readonly questionRef: string; readonly sourcePrefixRef: string;
  readonly previous?: UserLearningVersion; readonly now: number };

/** Semantic interpretation cannot turn a quality repair, permission or task instruction into a durable preference. */
export function buildSemanticUserVersion(input: Input): UserLearningVersion {
  const evidenceById = new Map(input.evidence.map(item => [item.id, item]));
  const eligibility = input.evidence.map(evidence => classifySemanticUserEligibility(evidence,
    input.draft.eligibility.find(item => item.evidenceId === evidence.id), input.now));
  const eligible = new Set(eligibility.filter(item => item.classification === "personalization_candidate").flatMap(item => item.sourceEvidenceIds));
  const conclusions: ConclusionRecord[] = input.draft.conclusions.filter(item => item.evidenceIds.length > 0
    && item.evidenceIds.every(id => eligible.has(id)) && item.counterEvidenceIds.every(id => evidenceById.has(id))).map(item => ({
    id: shortId("user-conclusion", [input.scopeFingerprint, JSON.stringify(item)]), userId: input.userId,
    statement: `${item.statement}（适用边界：${item.conditions}）`, dimension: item.dimension, scopeFingerprint: input.scopeFingerprint,
    supporting: item.evidenceIds, counter: item.counterEvidenceIds, contextual: [], strength: 0.5,
    temporalState: item.counterEvidenceIds.length > 0 ? "disputed" : "emerging", status: "active", version: 1,
    stableKey: shortId("user-conclusion-key", [input.scopeFingerprint, item.key]), createdAt: input.now, updatedAt: input.now,
  }));
  const conclusionKeys = new Map(input.draft.conclusions.map(item => [item.key,
    conclusions.find(conclusion => conclusion.id === shortId("user-conclusion", [input.scopeFingerprint, JSON.stringify(item)]))]));
  const models: UserModelRecord[] = input.draft.models.flatMap(item => {
    const sources = item.conclusionKeys.map(key => conclusionKeys.get(key));
    if (sources.length === 0 || sources.some(source => source === undefined) || classifyInferenceDistance(item.statement, "") === "D3") return [];

    const first = sources[0]!;

    return [{ id: shortId("user-model", [input.scopeFingerprint, JSON.stringify(item), ...sources.map(source => source!.id)]),
      userId: input.userId, statement: item.statement, dimension: first.dimension, scopeFingerprint: input.scopeFingerprint,
      truth: { score: 0.5, band: "low" as const }, scope: { score: 0.5, band: "low" as const }, effectiveness: "unknown" as const,
      confirmation: "unconfirmed" as const, distance: item.distance, alternativeExplanations: item.alternatives,
      derivedFromConclusionIds: sources.map(source => source!.id), counterevidence: sources.flatMap(source => source!.counter),
      status: "active" as const, version: 1, stableKey: shortId("user-model-key", [input.scopeFingerprint, item.key]),
      createdAt: input.now, updatedAt: input.now }];
  });
  const modelKeys = new Map(input.draft.models.map(item => [item.key, models.find(model => model.stableKey === shortId("user-model-key", [input.scopeFingerprint, item.key]))]));
  const policies = input.draft.policies.flatMap(item => {
    const model = modelKeys.get(item.modelKey);
    if (model === undefined || item.evidenceIds.length === 0 || !item.evidenceIds.every(id => eligible.has(id))
      || !safeUserPolicyInstruction(item.instruction)) return [];

    // Compilation remains an inference even when it reuses words from a human
    // sentence; substring overlap cannot establish the user's intended directive.
    const id = shortId("user-policy", [input.scopeFingerprint, JSON.stringify(item), model.id]);

    return [{ rule: { id, bundleId: "pending", domain: model.dimension, kind: "prompt_directive" as const,
      strength: "advisory" as const, originMark: "inferred" as const,
      instruction: item.instruction, sourceUserModelIds: [model.id], sourceConclusionIds: model.derivedFromConclusionIds,
      sourceEvidenceIds: item.evidenceIds, sourceCommitmentIds: [], status: "active" as const, version: 1, createdAt: input.now },
      includeTerms: item.includeTerms, excludeTerms: item.excludeTerms, applicability: item.applicability }];
  });
  const revisions = (input.draft.policyRevisions ?? []).filter(revision => {
    const source = evidenceById.get(revision.evidenceId);
    const prior = input.previous?.policies.find(item => item.rule.id === revision.ruleId);
    if (source === undefined || !eligible.has(source.id) || prior === undefined || !source.rawText.includes(revision.quote)) return false;

    const specific = revision.quote.includes(prior.rule.id) || revision.quote.includes(prior.rule.instruction)
      || prior.includeTerms.some(term => term.trim().length >= 2 && revision.quote.toLowerCase().includes(term.toLowerCase()));
    if (!specific) return false;

    // The model chooses the specific rule. The quoted human source must actually
    // request a policy change; a bare "wrong" or a task exception cannot retire it.
    return /(?:撤销|撤回|停用|取消).{2,}(?:偏好|政策|规则|做法)|(?:以后|今后|默认).{0,40}(?:不要|别再|改为|改成)|(?:from now on|always|future).{0,80}(?:don't|do not|instead|stop)/iu.test(revision.quote)
      && !/仅本次|这次先|only this time/iu.test(revision.quote);
  });
  const retired = new Set(revisions.map(item => item.ruleId));
  // Reassessment concerns supplied original support only. Missing old evidence
  // cannot retire knowledge; an explicit non-preference classification can.
  const disqualified = new Set(eligibility.filter(item => item.classification !== "personalization_candidate").flatMap(item => item.sourceEvidenceIds));
  const combinedConclusions = [...(input.previous?.conclusions ?? []).filter(item => !conclusions.some(next => next.id === item.id)
    && !item.supporting.some(id => disqualified.has(id))), ...conclusions];
  const validConclusions = new Set(combinedConclusions.map(item => item.id));
  const combinedModels = [...(input.previous?.models ?? []).filter(item => !models.some(next => next.id === item.id)
    && item.derivedFromConclusionIds.every(id => validConclusions.has(id))), ...models];
  const validModels = new Set(combinedModels.map(item => item.id));
  const combinedPolicies = [...(input.previous?.policies ?? []).filter(item => !retired.has(item.rule.id) && !policies.some(next => next.rule.id === item.rule.id)
    && !item.rule.sourceEvidenceIds.some(id => disqualified.has(id)) && item.rule.sourceUserModelIds.every(id => validModels.has(id))), ...policies];
  const combinedEvidenceIds = [...new Set([...(input.previous?.evidenceIds ?? []), ...input.evidence.map(item => item.id)])];
  const combinedEligibility = [...(input.previous?.eligibility ?? []).filter(item => !item.sourceEvidenceIds.some(id => evidenceById.has(id))), ...eligibility];
  const availability = input.draft.progress.state === "completed" || input.draft.progress.state === "no_result" ? "ready" : "candidate";
  const payload = { scope: input.scopeFingerprint, source: input.sourcePrefixRef, availability, conclusions: combinedConclusions.map(item => item.id),
    models: combinedModels.map(item => item.id), policies: combinedPolicies.map(item => item.rule.id), revisions,
    eligibility: combinedEligibility.map(item => ({ id: item.id, classification: item.classification, rationale: item.rationale })) };
  const versionId = `user-version:${sha256Hex(JSON.stringify(payload))}`;

  return { schemaVersion: 1, versionId, availability,
    ...(input.previous === undefined ? {} : { previousVersionId: input.previous.versionId }),
    questionRef: input.questionRef, sourcePrefixRef: input.sourcePrefixRef, scopeFingerprint: input.scopeFingerprint,
    evidenceIds: combinedEvidenceIds, eligibility: combinedEligibility, conclusions: combinedConclusions, models: combinedModels,
    policies: combinedPolicies.map(item => ({ ...item, rule: { ...item.rule, bundleId: versionId } })), revisions,
    bundleChecksum: sha256Hex(JSON.stringify(combinedPolicies.map(item => [item.rule.id, item.rule.instruction]))), at: input.now };
}
