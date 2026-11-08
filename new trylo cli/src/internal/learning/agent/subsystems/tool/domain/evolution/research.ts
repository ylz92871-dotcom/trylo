import { isJsonValue, jsonBytes, keysAre, recordOf, textOf } from "./parse.js";
import { decodeDiscoverySummary, type ToolDiscoverySummary } from "./discovery.js";
import type { ToolLibraryInvestigation } from "./reuse-retrieval.js";
import { isIsoTime } from "./artifact.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { isToolPipelineCounter } from "./pipeline-lifetime.js";
import { isNpmSha512Integrity, npmRegistryArchiveUrl } from "../../../../../../tooling/contract/npm-source.js";

export const MAX_TOOL_RESEARCH_STEPS = 16;
export const MAX_TOOL_RESEARCH_TEXT = 12_000;

export type ToolResearchCandidate = { readonly platform: "github" | "npm"; readonly id: string; readonly version?: string };

export type ToolInspectionRequest = { readonly candidate: ToolResearchCandidate; readonly path?: string };

export type ToolResearchRequest = { readonly kind: "search"; readonly query: string }
  | { readonly kind: "library"; readonly query: string }
  | ({ readonly kind: "inspect" } & ToolInspectionRequest);

type ResearchNpmPackage = { readonly name: string; readonly version: string };

export type ToolResearchDocumentBasis =
  | { readonly kind: "registry_version_metadata"; readonly package: ResearchNpmPackage;
      readonly archiveClaim?: { readonly archiveUrl: string; readonly integrity: string } }
  | { readonly kind: "repository_reference"; readonly repository: string;
      readonly refKind: "commit" | "mutable_ref" | "default_branch"; readonly requestedRef?: string; readonly blobSha?: string;
      readonly npmLink?: { readonly package: ResearchNpmPackage; readonly relationship: "publisher_claimed_gitHead" } };

export type ToolResearchDocument = {
  readonly sourceUrl: string; readonly path: string; readonly contentHash: string;
  readonly kind: "metadata" | "documentation" | "source" | "directory";
  readonly text: string; readonly truncated: boolean; readonly revision?: string;
  /** Hashes rendered evidence before its prompt excerpt, never downloaded package bytes. */
  readonly contentHashBasis?: "canonical_rendered_text";
  readonly basis?: ToolResearchDocumentBasis;
};

export type ToolGenerationResearchReference = Omit<ToolResearchDocument, "text"> & {
  readonly text?: string; readonly sourceBodyWithheld?: "repository_source_is_not_reviewed_installation_bytes";
};

export type ToolNpmResearchReferences = {
  readonly installationId: string; readonly package: ResearchNpmPackage;
  readonly implementationBasis: "reviewed_installation_files";
  readonly repositoryTarballEquivalence: "not_established";
  readonly observations: readonly { readonly researchVersionId: string; readonly occurredAt: string;
    readonly origin?: { readonly jobId: string; readonly capability: string };
    readonly archiveClaimAlignment: "same_reviewed_archive_claim" | "conflicting_archive_claim" | "not_compared";
    readonly documents: readonly ToolGenerationResearchReference[] }[];
};

/** Full repository code is available to the strategy researcher, but source
 * construction receives only admitted installation bytes from its own reader.
 * Documentation/API examples and metadata remain explicitly untrusted hints. */
export function toolGenerationResearchReference(document: ToolResearchDocument, maxTextChars = 2_000): ToolGenerationResearchReference {
  const { text, ...reference } = document;
  if (document.kind === "source") return { ...reference, truncated: true,
    sourceBodyWithheld: "repository_source_is_not_reviewed_installation_bytes" };
  const limit = Number.isSafeInteger(maxTextChars) && maxTextChars >= 0 ? Math.min(maxTextChars, MAX_TOOL_RESEARCH_TEXT) : 2_000;
  return { ...reference, text: text.slice(0, limit), truncated: document.truncated || text.length > limit };
}

/** Remote text is evidence about an interface, never instructions, source admission or a verdict. */
export type ToolInspectionReport = {
  readonly status: "complete" | "failed"; readonly candidate: ToolResearchCandidate;
  readonly documents: readonly ToolResearchDocument[]; readonly code?: string;
};

export type ToolResearchStep = {
  readonly type: "tool_learning_research"; readonly schemaVersion: 1;
  readonly jobId: string; readonly scope: string; readonly capability: string;
  readonly attempt: number; readonly step: number; readonly occurredAt: string;
  readonly request: ToolResearchRequest;
  readonly discovery?: ToolDiscoverySummary; readonly inspection?: ToolInspectionReport;
  readonly library?: ToolLibraryInvestigation;
};

export type ToolPlanningHistory = {
  readonly decisionVersionId: string; readonly attempt: number; readonly action: string;
  readonly rationale: string; readonly existingInsufficiency: string; readonly code?: string;
};

export type ToolResearchBoundary = { readonly furtherInvestigation: "closed";
  readonly reason: "research_request_repeated" | "research_no_new_information" | "research_capacity" };

export function decodeToolInspectionRequest(raw: unknown): ToolInspectionRequest | undefined {
  if (!recordOf(raw) || !keysAre(raw, ["candidate"], ["path"]) || !candidateShape(raw.candidate)
    || (raw.path !== undefined && !safeResearchPath(raw.path))) return undefined;
  return { candidate: { ...raw.candidate }, ...(raw.path === undefined ? {} : { path: raw.path }) };
}

export function decodeToolInspectionReport(raw: unknown): ToolInspectionReport | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || jsonBytes(raw) > 64_000
    || !keysAre(raw, ["status", "candidate", "documents"], ["code"]) || !candidateShape(raw.candidate)
    || !["complete", "failed"].includes(String(raw.status)) || !Array.isArray(raw.documents) || raw.documents.length > 3
    || (raw.code !== undefined && !textOf(raw.code, 160))) return undefined;

  for (const item of raw.documents) {
    if (!recordOf(item) || !keysAre(item, ["sourceUrl", "path", "contentHash", "kind", "text", "truncated"], ["revision", "contentHashBasis", "basis"])
      || !publicResearchUrl(item.sourceUrl) || !textOf(item.path, 512) || !hash(item.contentHash)
      || !["metadata", "documentation", "source", "directory"].includes(String(item.kind))
      || !textOf(item.text, MAX_TOOL_RESEARCH_TEXT) || typeof item.truncated !== "boolean"
      || (item.revision !== undefined && !textOf(item.revision, 256))
      || (item.contentHashBasis !== undefined && item.contentHashBasis !== "canonical_rendered_text")
      || (item.contentHashBasis === "canonical_rendered_text" && !item.truncated && item.contentHash !== contentHashOf(item.text))
      || (item.basis !== undefined && (item.contentHashBasis !== "canonical_rendered_text" || !documentBasis(item.basis, raw.candidate, item.sourceUrl)))) return undefined;
  }

  if ((raw.status === "failed" && (raw.code === undefined || raw.documents.length !== 0))
    || (raw.status === "complete" && (raw.code !== undefined || raw.documents.length === 0))) return undefined;

  return structuredClone(raw) as ToolInspectionReport;
}

export function decodeToolResearchStep(raw: unknown): ToolResearchStep | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || jsonBytes(raw) > 128_000
    || !keysAre(raw, ["type", "schemaVersion", "jobId", "scope", "capability", "attempt", "step", "occurredAt", "request"], ["discovery", "inspection", "library"])
    || raw.type !== "tool_learning_research" || raw.schemaVersion !== 1
    || !textOf(raw.jobId, 160) || !textOf(raw.scope, 512) || !textOf(raw.capability, 512) || !isIsoTime(raw.occurredAt)
    || !isToolPipelineCounter(raw.attempt) || !isToolPipelineCounter(raw.step)
    || !recordOf(raw.request)) return undefined;

  const request = raw.request;
  if (request.kind === "library" && keysAre(request, ["kind", "query"]) && textOf(request.query, 512)
    && raw.discovery === undefined && raw.inspection === undefined && decodeToolLibraryInvestigation(raw.library)?.query === request.query) return structuredClone(raw) as ToolResearchStep;

  if (request.kind === "search" && keysAre(request, ["kind", "query"]) && textOf(request.query, 512)
    && raw.inspection === undefined && raw.library === undefined && decodeDiscoverySummary(raw.discovery) !== undefined) return structuredClone(raw) as ToolResearchStep;

  const inspection = decodeToolInspectionReport(raw.inspection);
  if (request.kind !== "inspect" || !keysAre(request, ["kind", "candidate"], ["path"]) || raw.discovery !== undefined || raw.library !== undefined
    || inspection === undefined || decodeToolInspectionRequest({ candidate: request.candidate, ...(request.path === undefined ? {} : { path: request.path }) }) === undefined
    || !recordOf(request.candidate) || inspection.candidate.platform !== request.candidate.platform
    || inspection.candidate.id !== request.candidate.id || inspection.candidate.version !== request.candidate.version) return undefined;

  return structuredClone(raw) as ToolResearchStep;
}

export function decodeToolLibraryInvestigation(raw: unknown): ToolLibraryInvestigation | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || !keysAre(raw, ["query", "candidates", "total", "truncated"])
    || !textOf(raw.query, 512) || typeof raw.total !== "number" || !Number.isSafeInteger(raw.total) || raw.total < 0 || raw.total > 100_000
    || typeof raw.truncated !== "boolean" || !Array.isArray(raw.candidates) || raw.candidates.length > 24 || raw.candidates.length > raw.total) return undefined;

  for (const candidate of raw.candidates) {
    if (!recordOf(candidate) || !keysAre(candidate, ["toolId", "description"], ["versionId"]) || !textOf(candidate.toolId, 512)
      || !textOf(candidate.description, 1_536) || (candidate.versionId !== undefined && !textOf(candidate.versionId, 160))) return undefined;
  }

  return structuredClone(raw) as ToolLibraryInvestigation;
}

export function safeResearchPath(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length <= 512 && !/[\\\u0000-\u0020?#:%]/u.test(raw)
    && !raw.startsWith("/") && raw.split("/").every(part => part !== "." && part !== "..");
}

function candidateShape(raw: unknown): raw is ToolResearchCandidate {
  if (!recordOf(raw) || !keysAre(raw, ["platform", "id"], ["version"]) || !textOf(raw.id, 512)
    || (raw.version !== undefined && (!textOf(raw.version, 128) || /[\u0000-\u0020?#]/u.test(raw.version)))) return false;
  return raw.platform === "github" ? /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(raw.id)
    && raw.id.split("/").every(part => part !== "." && part !== "..")
    : raw.platform === "npm" && /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/u.test(raw.id) && raw.version !== undefined;
}

function publicResearchUrl(raw: unknown): raw is string {
  if (!textOf(raw, 2_048)) return false;
  try { const url = new URL(raw);
  return url.protocol === "https:" && url.username === "" && url.password === ""
    && (url.port === "" || url.port === "443") && ["api.github.com", "github.com", "registry.npmjs.org", "www.npmjs.com"].includes(url.hostname); }
  catch { return false; }
}

function hash(raw: unknown): raw is string { return typeof raw === "string" && /^[a-f0-9]{64}$/u.test(raw); }

function documentBasis(raw: unknown, candidate: ToolResearchCandidate, sourceUrl: string): raw is ToolResearchDocumentBasis {
  if (!recordOf(raw)) return false;

  const packageMatches = (value: unknown): value is ResearchNpmPackage => recordOf(value) && keysAre(value, ["name", "version"])
    && candidate.platform === "npm" && value.name === candidate.id && value.version === candidate.version;

  if (raw.kind === "registry_version_metadata") {
    if (!keysAre(raw, ["kind", "package"], ["archiveClaim"]) || !packageMatches(raw.package)
      || new URL(sourceUrl).hostname !== "registry.npmjs.org") return false;
    return raw.archiveClaim === undefined || recordOf(raw.archiveClaim) && keysAre(raw.archiveClaim, ["archiveUrl", "integrity"])
      && raw.archiveClaim.archiveUrl === npmRegistryArchiveUrl(raw.package.name, raw.package.version) && isNpmSha512Integrity(raw.archiveClaim.integrity);
  }

  if (raw.kind !== "repository_reference" || !keysAre(raw, ["kind", "repository", "refKind"], ["requestedRef", "blobSha", "npmLink"])
    || !textOf(raw.repository, 512) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(raw.repository)
    || !["commit", "mutable_ref", "default_branch"].includes(String(raw.refKind))
    || (raw.requestedRef !== undefined && !textOf(raw.requestedRef, 128))
    || (raw.refKind === "default_branch") !== (raw.requestedRef === undefined)
    || (raw.refKind === "commit" && (typeof raw.requestedRef !== "string" || !/^[a-f0-9]{40}$/u.test(raw.requestedRef)))
    || (raw.blobSha !== undefined && (typeof raw.blobSha !== "string" || !/^[a-f0-9]{40}$/u.test(raw.blobSha)))) return false;

  const url = new URL(sourceUrl);
  if (url.hostname !== "api.github.com" || !url.pathname.startsWith(`/repos/${raw.repository}/`)
    || (url.searchParams.get("ref") ?? undefined) !== raw.requestedRef) return false;

  if (candidate.platform === "github") return candidate.id.toLowerCase() === raw.repository.toLowerCase() && raw.npmLink === undefined;

  return recordOf(raw.npmLink) && keysAre(raw.npmLink, ["package", "relationship"]) && packageMatches(raw.npmLink.package)
    && raw.npmLink.relationship === "publisher_claimed_gitHead" && raw.refKind === "commit";
}
