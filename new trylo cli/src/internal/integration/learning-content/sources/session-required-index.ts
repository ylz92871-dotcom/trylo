import type { ContentEvidenceRecord, ContentMaterialBatch, ContentSubsystem } from "../../../learning/central/content/material-contract.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { identity, sequence } from "../../../validation/json-shape.js";
import type { ContentSourceTextView } from "./source-text-view.js";

export interface RequiredUserCatalogAddress { readonly sessionId: string; readonly turnId: string; readonly through: number; readonly sourceHash: string }

export interface RequiredUserIndex {
  readonly batch: ContentMaterialBatch;
  readonly catalog: ContentEvidenceRecord;
  readonly availableSources: number;
  readonly shownSources: number;
  readonly taskPurpose: string;
}

const prefix = "session-required-users:";

function address(value: RequiredUserCatalogAddress): string {
  return `${prefix}${encodeURIComponent(value.sessionId)}/${encodeURIComponent(value.turnId)}/${value.through.toString(36)}/${value.sourceHash}`;
}

export function readRequiredUserCatalogAddress(ref: string): RequiredUserCatalogAddress | undefined {
  if (!ref.startsWith(prefix) || ref.length > 256) return undefined;

  const parts = ref.slice(prefix.length).split("/");
  if (parts.length !== 4 || !/^[0-9a-z]+$/.test(parts[2]!) || !/^[a-f0-9]{64}$/.test(parts[3]!)) return undefined;

  try {
    const value = { sessionId: decodeURIComponent(parts[0]!), turnId: decodeURIComponent(parts[1]!), through: Number.parseInt(parts[2]!, 36), sourceHash: parts[3]! };
    return identity(value.sessionId) && identity(value.turnId) && sequence(value.through) && address(value) === ref ? value : undefined;
  } catch { return undefined; }
}

/** Source locators only. Neither an index entry nor its alias proves any user text entered a model input. */
export function buildRequiredUserIndex(input: { readonly sources: readonly ContentSourceTextView[]; readonly sessionId: string; readonly turnId: string;
  readonly through: number; readonly scope: string; readonly subsystem: ContentSubsystem; readonly maximumChars: number }):
  { readonly ok: true; readonly value: RequiredUserIndex } | { readonly ok: false; readonly reason: "content_material_capacity" } {
  const sources = input.sources.map(view => ({ originalRef: view.original.ref, sourceRef: view.record.ref,
    sourceHash: contentHashOf(view.record.text), coordinate: { runId: view.record.runId, sequence: view.record.sequence },
    originalSourceHash: view.original.sourceHash, originalCoordinate: { runId: view.original.runId, sequence: view.original.sequence },
    totalChars: view.record.text.length, read: { ref: view.record.ref, start: 0, maximumChars: 8192 } }));
  const text = canonicalJson({ schemaVersion: 1, role: "source_owned_unread_user_requirement_catalog", sessionId: input.sessionId,
    turnId: input.turnId, observedThrough: input.through, availableSources: sources.length, sources,
    interpretation: "These are all original user-source locators in this fixed turn prefix. This catalog is not their text, an answer, or a proof they were read. Read original source pages before assessing their requirements." });
  const sourceHash = contentHashOf(text), catalogRef = address({ sessionId: input.sessionId, turnId: input.turnId, through: input.through, sourceHash });
  if (catalogRef.length > 256) return { ok: false, reason: "content_material_capacity" };

  const catalog: ContentEvidenceRecord = { ref: catalogRef, runId: catalogRef, sequence: 0, scope: input.scope, origin: "execution_result", text };
  const shown: typeof sources = [];
  const build = (): ContentMaterialBatch => {
    const body = canonicalJson({ schemaVersion: 1, role: "source_owned_unread_user_requirement_collection", sessionId: input.sessionId, turnId: input.turnId,
      availableSources: sources.length, shownSources: shown.length, omittedSources: sources.length - shown.length, sources: shown,
      catalog: { ref: catalogRef, sourceHash, totalChars: text.length },
      interpretation: "All current user sources remain requirements. The index is source-owned metadata, not user prose. Their full text is unread here; unlisted sources remain in the complete paged catalog. No requirement is inferred satisfied or answered." });
    const ref = `session-required-user-index:${contentHashOf(body)}`;

    return { records: [{ ref, runId: ref, sequence: 0, scope: input.scope, origin: "execution_result", text: body }], answers: [],
      requirements: [{ id: ref, requirement: `${sources.length} original user requirements are unread in this indexed collection; retain every source and its original order.`,
        answerRequirement: "Read the complete source directory and the original user text needed for the task. This locator index is not the user's complete answer requirement.",
        conditions: ["Do not silently replace earlier queued requirements with the latest user input. Partial source pages do not prove complete coverage."], sourceRefs: [ref, catalogRef] }],
      materials: [{ id: ref, kind: "requirement", subsystem: input.subsystem, context: "Source-owned collection of unread original user requirements with exact source hashes and cold-readable addresses.",
        recordRefs: [ref, catalogRef], requirementIds: [ref], answerIds: [], links: { issueIds: [], topicIds: [], artifactRefs: [] } }] };
  };
  const budget = Math.min(8000, input.maximumChars);
  if (canonicalJson(build()).length > budget) return { ok: false, reason: "content_material_capacity" };

  for (const source of sources) {
    shown.push(source);
    if (canonicalJson(build()).length > budget) {
    shown.pop();
    break;
  }
  }

  return { ok: true, value: { batch: build(), catalog, availableSources: sources.length, shownSources: shown.length,
    taskPurpose: input.sources.slice(0, 256).map(view => view.record.text.slice(0, Math.max(1, Math.floor(3000 / Math.max(1, input.sources.length))))).join("\n").slice(0, 3000) } };
}
