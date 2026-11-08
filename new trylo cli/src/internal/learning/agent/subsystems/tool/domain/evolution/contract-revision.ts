import type { ApprovalConsumptionReceipt } from "../../../../../../ports/approval-consumption.js";
import { contentHashOf, canonicalJson } from "../../../../../control/hash.js";
import type { ToolEvolutionExpected, ToolEvolutionSample } from "./contracts.js";
import { isDigest, isIsoTime } from "./artifact.js";
import { isJsonValue, jsonBytes, keysAre, parseToolEvolutionSample, recordOf, textOf } from "./parse.js";

export type ToolContractRevisionProposal = {
  readonly type: "tool_contract_revision_proposal";
  readonly schemaVersion: 1;
  readonly parentVersionId: string;
  readonly parentContractHash: string;
  readonly scope: string;
  readonly reason: "incorrect_expectation" | "changed_requirement";
  readonly corrections: readonly {
    readonly sampleId: string;
    readonly oldSampleHash: string;
    readonly oldExpectedHash: string;
    readonly expected: ToolEvolutionExpected;
    readonly evidenceRefs: readonly string[];
  }[];
};

/** This shape is only written after the existing Permission owner consumed a
 * matching modify grant. Its decoder checks binding, not grant authenticity. */
export type ApprovedToolContractRevision = {
  readonly type: "tool_contract_revision_approved";
  readonly schemaVersion: 1;
  readonly revisionId: string;
  readonly proposal: ToolContractRevisionProposal;
  readonly approval: ApprovalConsumptionReceipt;
};

type RevisionFailure = { readonly ok: false; readonly code: string; readonly message: string };

type RevisionResult = RevisionFailure | { readonly ok: true; readonly effectiveSamples: readonly ToolEvolutionSample[] };

export function toolContractProposalId(proposal: ToolContractRevisionProposal): string {
  return `tool-contract-proposal_v1_${contentHashOf(proposal)}`;
}

export function toolContractRevisionId(proposal: ToolContractRevisionProposal): string {
  return `tool-contract-revision_v1_${contentHashOf(proposal)}`;
}

export function contractRevisionReviewId(proposal: ToolContractRevisionProposal): string {
  return `tool-contract-review_v1_${contentHashOf(proposal)}`;
}

export function contractRevisionWithdrawalReviewId(proposal: ToolContractRevisionProposal, approved: boolean): string {
  return `tool-contract-withdraw-review_v1_${contentHashOf({ proposal, approved })}`;
}

export function decodeToolContractRevisionProposal(raw: unknown): ToolContractRevisionProposal | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || jsonBytes(raw) > 128 * 1024
    || !keysAre(raw, ["type", "schemaVersion", "parentVersionId", "parentContractHash", "scope", "reason", "corrections"])
    || raw.type !== "tool_contract_revision_proposal" || raw.schemaVersion !== 1 || !textOf(raw.parentVersionId, 160)
    || !isDigest(raw.parentContractHash) || !textOf(raw.scope, 512)
    || (raw.reason !== "incorrect_expectation" && raw.reason !== "changed_requirement")
    || !Array.isArray(raw.corrections) || raw.corrections.length < 1 || raw.corrections.length > 8) return undefined;

  const corrections: ToolContractRevisionProposal["corrections"][number][] = [];

  for (const item of raw.corrections) {
    if (!recordOf(item) || !keysAre(item, ["sampleId", "oldSampleHash", "oldExpectedHash", "expected", "evidenceRefs"])
      || !textOf(item.sampleId, 128) || !isDigest(item.oldSampleHash) || !isDigest(item.oldExpectedHash)
      || corrections.some(prior => prior.sampleId === item.sampleId) || !refs(item.evidenceRefs)) return undefined;

    const sample = parseToolEvolutionSample({ sampleId: item.sampleId, role: "counterexample", input: null, expected: item.expected });
    if (!sample.ok) return undefined;

    corrections.push({ sampleId: item.sampleId, oldSampleHash: item.oldSampleHash, oldExpectedHash: item.oldExpectedHash,
      expected: sample.value.expected, evidenceRefs: [...item.evidenceRefs] });
  }

  return { type: raw.type, schemaVersion: 1, parentVersionId: raw.parentVersionId, parentContractHash: raw.parentContractHash,
    scope: raw.scope, reason: raw.reason, corrections };
}

export function decodeApprovedToolContractRevision(raw: unknown): ApprovedToolContractRevision | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || !keysAre(raw, ["type", "schemaVersion", "revisionId", "proposal", "approval"])
    || raw.type !== "tool_contract_revision_approved" || raw.schemaVersion !== 1) return undefined;

  const proposal = decodeToolContractRevisionProposal(raw.proposal), receipt = raw.approval;
  if (proposal === undefined || raw.revisionId !== toolContractRevisionId(proposal) || !recordOf(receipt)
    || !keysAre(receipt, ["grantId", "action", "candidateId", "packageVersionId", "scope", "consumedAt", "sequence"])
    || !textOf(receipt.grantId, 256) || receipt.action !== "modify" || receipt.candidateId !== contractRevisionReviewId(proposal)
    || receipt.packageVersionId !== proposal.parentVersionId || receipt.scope !== proposal.scope || !isIsoTime(receipt.consumedAt)
    || typeof receipt.sequence !== "number" || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) return undefined;

  return { type: raw.type, schemaVersion: 1, revisionId: raw.revisionId, proposal,
    approval: { grantId: receipt.grantId, action: receipt.action, candidateId: receipt.candidateId, packageVersionId: receipt.packageVersionId,
      scope: receipt.scope, consumedAt: receipt.consumedAt, sequence: receipt.sequence } };
}

/** Test exact old bytes before replacing expected values. No input, role, sample
 * deletion or implicit last-writer-wins operation exists in this language. */
export function applyToolContractRevisions(input: { readonly parentVersionId: string; readonly scope: string;
  readonly parentSamples: readonly ToolEvolutionSample[]; readonly revisions: readonly ApprovedToolContractRevision[] }): RevisionResult {
  const proposals: ToolContractRevisionProposal[] = [];

  for (const value of input.revisions) {
    const revision = decodeApprovedToolContractRevision(value);
    if (revision === undefined) return failure("contract_revision_not_approved", "a proposal or model/verifier label cannot replace approval consumption evidence");
    proposals.push(revision.proposal);
  }

  return revisedSamples({ ...input, proposals });
}

/** Computes a reviewable diff only. This path never yields an approved revision
 * and cannot be passed to preserveOrReviseToolSamples as authority. */
export function previewToolContractRevision(input: { readonly parentVersionId: string; readonly scope: string;
  readonly parentSamples: readonly ToolEvolutionSample[]; readonly proposal: ToolContractRevisionProposal }): RevisionResult {
  return revisedSamples({ ...input, proposals: [input.proposal] });
}

function revisedSamples(input: { readonly parentVersionId: string; readonly scope: string;
  readonly parentSamples: readonly ToolEvolutionSample[]; readonly proposals: readonly ToolContractRevisionProposal[] }): RevisionResult {
  const replacements = new Map<string, ToolEvolutionExpected>();

  for (const value of input.proposals) {
    const proposal = decodeToolContractRevisionProposal(value);
    if (proposal === undefined || proposal.parentVersionId !== input.parentVersionId || proposal.scope !== input.scope
      || proposal.parentContractHash !== contentHashOf(input.parentSamples)) return failure("contract_revision_parent_mismatch", "the approved correction does not identify these exact parent checks");

    for (const correction of proposal.corrections) {
      const sample = input.parentSamples.find(item => item.sampleId === correction.sampleId);
      if (sample === undefined || contentHashOf(sample) !== correction.oldSampleHash || contentHashOf(sample.expected) !== correction.oldExpectedHash) {
        return failure("contract_revision_stale", "the approved correction's original sample or expected bytes changed");
      }

      if (canonicalJson(sample.expected) === canonicalJson(correction.expected)) return failure("contract_revision_no_change", "a correction must explicitly change an expected value");

      const checked = parseToolEvolutionSample({ ...sample, expected: correction.expected });
      if (!checked.ok) return failure("contract_revision_role_mismatch", "correcting expected cannot silently change a source sample's role");

      const previous = replacements.get(sample.sampleId);
      if (previous !== undefined && canonicalJson(previous) !== canonicalJson(correction.expected)) return failure("contract_revision_conflict", "approved corrections disagree; select an externally resolved contract");

      replacements.set(sample.sampleId, correction.expected);
    }
  }

  return { ok: true, effectiveSamples: input.parentSamples.map(sample => ({ ...sample, expected: structuredClone(replacements.get(sample.sampleId) ?? sample.expected) })) };
}

/** The same contract rule serves autonomous planning, manual improvement and npm
 * adaptation. A grant permits specified oracle replacements, not arbitrary test edits. */
export function preserveOrReviseToolSamples(input: { readonly parentVersionId: string; readonly scope: string;
  readonly parentSamples: readonly ToolEvolutionSample[]; readonly proposedSamples: readonly ToolEvolutionSample[];
  readonly revisions: readonly ApprovedToolContractRevision[] }): RevisionResult {
  const applied = applyToolContractRevisions(input);
  if (!applied.ok) return applied;

  for (const sample of applied.effectiveSamples) if (!input.proposedSamples.some(next => canonicalJson(next) === canonicalJson(sample))) {
    return failure("prior_contract_weakened", "every unchanged check and every explicitly corrected check must remain in the new contract");
  }

  const inputs = new Map<string, string>();

  for (const sample of input.proposedSamples) {
    if (!parseToolEvolutionSample(sample).ok) return failure("invalid_samples", "new checks must satisfy the existing sample contract");
    const key = contentHashOf(sample.input), expected = contentHashOf(sample.expected), prior = inputs.get(key);
    if (prior !== undefined && prior !== expected) return failure("contract_sample_conflict", "one input cannot have contradictory expected answers in a pure JSON tool contract");
    inputs.set(key, expected);
  }

  return { ok: true, effectiveSamples: structuredClone(input.proposedSamples) };
}

function refs(raw: unknown): raw is readonly string[] {
  return Array.isArray(raw) && raw.length >= 1 && raw.length <= 16 && raw.every(item => textOf(item, 256)) && new Set(raw).size === raw.length;
}

function failure(code: string, message: string): RevisionFailure { return { ok: false, code, message }; }
