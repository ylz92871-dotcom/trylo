import type { ContentEvidenceRecord } from "../../../learning/central/content/material-contract.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { redactText } from "../../../credentials/redact.js";
import { redactJsonValue } from "../../../protocol/redact.js";
import { fields, identity, sequence } from "../../../validation/json-shape.js";

export const CONTENT_SOURCE_VIEW_POLICY = "workspace_relative_then_original_host_redaction_v1";

export interface ContentSourceTextView {
  readonly record: ContentEvidenceRecord;
  readonly original: { readonly ref: string; readonly runId: string; readonly sequence: number; readonly sourceHash: string };
  readonly changed: boolean;
}

export const contentSourceTextViewRef = (ref: string, sourceHash: string, projectionHash: string) =>
  `content-source-view:${contentHashOf([CONTENT_SOURCE_VIEW_POLICY, ref, sourceHash, projectionHash])}`;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Preserve workspace-relative file identities in model prose, then apply the existing
 * export redactor. A changed source always has its own ref/coordinate and raw-source hash. */
export function projectContentSourceText(record: ContentEvidenceRecord, secrets: readonly string[] = []): ContentSourceTextView {
  const original = Object.freeze({ ref: record.ref, runId: record.runId, sequence: record.sequence, sourceHash: contentHashOf(record.text) });
  const scrubbed = redactText(record.text, secrets);
  if (redactJsonValue(scrubbed) === record.text) return { record, original, changed: false };

  let text = scrubbed;
  const variants = [...new Set([record.scope, record.scope.replaceAll("\\", "/"), JSON.stringify(record.scope).slice(1, -1)])]
    .filter(scope => /^(?:[A-Za-z]:[\\/]|\/(?:home|Users|tmp|var|etc|usr|root)\/)/.test(scope))
    .map(scope => scope.replace(/[\\/]+$/, "")).sort((a, b) => b.length - a.length);

  for (const scope of variants) {
    const escaped = scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`${escaped}(?=[\\\\/\\s\"'\x60]|$)`, /^[A-Za-z]:/.test(scope) ? "gi" : "g"), "<workspace>");
  }

  const safe = redactJsonValue(text);
  if (typeof safe !== "string") throw new Error("content_source_view_invalid");

  const ref = contentSourceTextViewRef(original.ref, original.sourceHash, contentHashOf(safe));

  return { record: Object.freeze({ ...record, ref, runId: ref, sequence: 0, text: safe }), original, changed: true };
}

export function contentSourceViewContext(view: ContentSourceTextView, originalContext: string): string {
  return canonicalJson({ schemaVersion: 1, source: "redacted_public_source_projection", policy: CONTENT_SOURCE_VIEW_POLICY,
    originalRef: view.original.ref, originalRunId: view.original.runId, originalSequence: view.original.sequence,
    originalSourceHash: view.original.sourceHash, projectionRef: view.record.ref, projectionHash: contentHashOf(view.record.text), originalContext });
}

/** Parse only the source owner's closed projection format. Arbitrary JSON in user text
 * cannot use it to acquire metadata privileges or claim a raw-source identity. */
export function readContentSourceViewContext(context: string, record: ContentEvidenceRecord) {
  if (record.runId !== record.ref || record.sequence !== 0) return undefined;
  return readContentSourceViewMetadata(context, { projectionRef: record.ref, projectionHash: contentHashOf(record.text) });
}

/** A source chunk retains its owner's full-view hash without pretending it carries
 * that full text. Its own chunk identity/range must still be checked by its source adapter. */
export function readContentSourceViewMetadata(context: string, projection: { readonly projectionRef: string; readonly projectionHash: string }) {
  let raw: unknown;

  try { raw = JSON.parse(context); }
  catch { return undefined; }

  if (!fields(raw, ["schemaVersion", "source", "policy", "originalRef", "originalRunId", "originalSequence", "originalSourceHash",
    "projectionRef", "projectionHash", "originalContext"]) || raw.schemaVersion !== 1 || raw.source !== "redacted_public_source_projection"
    || raw.policy !== CONTENT_SOURCE_VIEW_POLICY || !identity(raw.originalRef) || !identity(raw.originalRunId) || !sequence(raw.originalSequence)
    || !hash(raw.originalSourceHash) || !hash(raw.projectionHash) || raw.projectionRef !== projection.projectionRef || raw.projectionHash !== projection.projectionHash
    || typeof raw.originalContext !== "string"
    || raw.projectionRef !== contentSourceTextViewRef(raw.originalRef, raw.originalSourceHash, raw.projectionHash)) return undefined;

  return { originalRef: raw.originalRef, originalRunId: raw.originalRunId, originalSequence: raw.originalSequence,
    originalSourceHash: raw.originalSourceHash, originalContext: raw.originalContext };
}
