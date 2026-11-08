import type { ContentEvidenceRecord } from "../../learning/central/content/material-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { isRedactedTopicData } from "../learning-topics/confidentiality.js";
import { readContentDomainFeedbackAbsence } from "./sources/domain-feedback-basis.js";
import { isContentValueCredentialSafe } from "./content-confidentiality-leaf.js";
import type { TrustedContentIdentity } from "./content-confidentiality.js";
import { parseIssueUserInputBasis } from "./sources/feedback-user-markers.js";

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const refs = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every(identity);

/** Closed source-format adapters, not semantic scenarios. Raw Session user/tool text
 * never enters these branches, regardless of JSON keys or a claimed role in its body. */
export function isContentHostRecordSafe(record: ContentEvidenceRecord, trusted: TrustedContentIdentity, secrets: readonly string[]): boolean {
  if (isRedactedTopicData(record.text, secrets)) return true;

  if (record.scope !== trusted.scope || record.origin !== "execution_result" || record.runId !== record.ref || record.sequence !== 0) return false;

  let raw: unknown;

  try { raw = JSON.parse(record.text); }
  catch { return false; }

  if (!isContentValueCredentialSafe(raw, secrets)) return false;

  if (record.ref === `content-recall:${contentHashOf(record.text)}`) return recallCatalog(raw, trusted.scope, secrets);

  if (record.ref === `content-user-source-basis:${contentHashOf(record.text)}`) {
    const basis = parseIssueUserInputBasis(record);
    return basis !== undefined && basis.scope === trusted.scope
      && isRedactedTopicData({ ...basis, scope: "[canonical_scope]" }, secrets);
  }

  if (record.ref === `content-recall-manifest:${contentHashOf(record.text)}`) return recallManifest(raw, trusted.scope, secrets);

  if (record.ref === `session-issue-source-manifest:${contentHashOf(record.text)}`) return issueSourceCatalog(raw, trusted.scope, secrets);

  if (record.ref.startsWith("domain-feedback-absence:")) {
    try {
      const values = readContentDomainFeedbackAbsence({ records: [record] });
      return values.length === 1 && values[0]!.scope === trusted.scope
        && record.text === canonicalJson(values[0])
        && isRedactedTopicData({ ...values[0], scope: "[canonical_scope]" }, secrets);
    } catch { return false; }
  }

  return false;
}

function issueSourceCatalog(raw: unknown, scope: string, secrets: readonly string[]): boolean {
  if (!fields(raw, ["role", "ref", "issueId", "scope", "available", "start", "shown", "omitted", "nextStart", "entries", "read", "interpretation"])
    || raw.role !== "canonical_issue_source_address_catalog_not_problem_or_answer_identity" || raw.scope !== scope
    || !identity(raw.ref) || !identity(raw.issueId) || ![raw.available, raw.start, raw.shown, raw.omitted].every(sequence)
    || raw.nextStart !== null && !sequence(raw.nextStart) || !Array.isArray(raw.entries) || raw.entries.length > 64
    || !fields(raw.read, ["ref", "start", "maximumChars"]) || raw.read.ref !== raw.ref || !sequence(raw.read.start) || !sequence(raw.read.maximumChars)) return false;

  const entries = [];

  for (const entry of raw.entries) {
    if (!fields(entry, ["ref", "sourceRefs", "originalScope", "role"]) || !identity(entry.ref) || !refs(entry.sourceRefs)
      || typeof entry.originalScope !== "string" || typeof entry.role !== "string") return false;
    entries.push({ ...entry, originalScope: entry.originalScope === scope ? "[canonical_scope]" : entry.originalScope });
  }

  return isRedactedTopicData({ ...raw, scope: "[canonical_scope]", entries }, secrets);
}

function recallCatalog(raw: unknown, scope: string, secrets: readonly string[]): boolean {
  return fields(raw, ["role", "scope", "boardSequence", "availableCandidates", "consideredCandidates", "selectedCandidates", "omittedCandidates",
    "selection", "relevanceIsNotIdentityOrAdequacy", "taskPurpose", "taskPurposeLength", "taskPurposeOmittedChars", "candidates", "display"])
    && raw.role === "host_retrieval_projection_not_task_result_or_learning_gain" && raw.scope === scope
    && [raw.boardSequence, raw.availableCandidates, raw.consideredCandidates, raw.omittedCandidates, raw.taskPurposeLength, raw.taskPurposeOmittedChars].every(sequence)
    && refs(raw.selectedCandidates) && Array.isArray(raw.candidates) && raw.candidates.length <= 64
    && raw.candidates.every(row => fields(row, ["id", "kind", "subsystem", "sequence", "active", "description", "descriptionLength", "descriptionOmittedChars", "sourceRefs", "sourceRefsOmitted"])
      && identity(row.id) && ["asset", "public_content", "native_method", "central_advisory"].includes(String(row.kind))
      && ["method", "tool", "workflow", "skill", "collaboration", "central_advisory"].includes(String(row.subsystem)) && typeof row.active === "boolean"
      && typeof row.description === "string" && row.description.length <= 128 && refs(row.sourceRefs)
      && [row.sequence, row.descriptionLength, row.descriptionOmittedChars, row.sourceRefsOmitted].every(sequence))
    && typeof raw.taskPurpose === "string" && raw.taskPurpose.length <= 512
    && fields(raw.display, ["availableCandidateCards", "shownCandidateCards", "omittedCandidateCards", "descriptionPreviewChars", "interpretation"])
    && [raw.display.availableCandidateCards, raw.display.shownCandidateCards, raw.display.omittedCandidateCards, raw.display.descriptionPreviewChars].every(sequence)
    && raw.display.interpretation === "bounded_retrieval_catalog_not_question_identity_or_answer_adequacy"
    && ["lexical_then_scope_recency", "semantic_recall"].includes(String(raw.selection)) && raw.relevanceIsNotIdentityOrAdequacy === true
    && isRedactedTopicData({ ...raw, scope: "[canonical_scope]" }, secrets);
}

function recallManifest(raw: unknown, scope: string, secrets: readonly string[]): boolean {
  if (!fields(raw, ["role", "sourceFactId", "originalPacketId", "processId", "originalFullRef", "readWith", "originalRecords", "listedOriginalRecords",
    "unlistedOriginalRecords", "productRefs", "unlistedProductRefs", "originalRequirements", "interpretation"])
    || raw.role !== "bounded_public_product_recall_original_evidence_deferred" || raw.readWith !== "read_material"
    || !Array.isArray(raw.listedOriginalRecords) || raw.listedOriginalRecords.length > 64 || !refs(raw.productRefs)) return false;

  const listed = [];

  for (const row of raw.listedOriginalRecords) {
    if (!fields(row, ["ref", "runId", "sequence", "scope", "origin", "chars", "sourceHash"]) || row.scope !== scope
      || !identity(row.ref) || !identity(row.runId) || !sequence(row.sequence) || !sequence(row.chars) || !hash(row.sourceHash)) return false;
    listed.push({ ...row, scope: "[canonical_scope]" });
  }

  return isRedactedTopicData({ ...raw, listedOriginalRecords: listed }, secrets);
}
