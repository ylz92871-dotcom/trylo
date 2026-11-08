import type { SessionPort } from "../../../ports/session.js";
import type { ContentMaterialBatch, ContentMaterialSource, ContentSubsystem } from "../../../learning/central/content/material-contract.js";
import type { TopicEvidenceOrigin } from "../../../learning/domains/shared/topics/contracts.js";

export interface SessionContentInput {
  readonly session: Pick<SessionPort, "readRecords">;
  readonly sessionId: string;
  readonly turnId: string;
  readonly scope: string;
  readonly subsystem: ContentSubsystem;
  readonly enabled: () => boolean;
  /** Source journal coordinate, independent of the Board sequence. */
  readonly through?: number;
  readonly maximumRecords?: number;
  readonly maximumChars?: number;
  /** Exact host-owned learning/control tool names; their returns are not business experience. */
  readonly excludeToolNames?: readonly string[];
  readonly secrets?: readonly string[];
  /** Read-only native IDs already proven compatible by the host. Original journal coverage retains its own ID. */
  readonly compatibleWorkspaceIds?: readonly string[];
  /** Canonical session registry lookup; the adapter verifies the original workspace identity before reading. */
  readonly lookupSession?: (sessionId: string, signal: AbortSignal) => Promise<Pick<SessionPort, "readRecords"> | undefined>;
  /** Exact task/turn registry search. Only explicit canonical task addresses invoke this lookup. */
  readonly lookupSessionsForTask?: (taskId: string, signal: AbortSignal) => Promise<readonly string[]>;
}

export interface SessionContentCoverage {
  readonly sessionId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly observedThrough: number;
  readonly considered: number;
  readonly included: number;
  readonly omitted: readonly string[];
  readonly tornTail: boolean;
  readonly coverage: "bounded_turn";
  /** The source collection is known, while its user text remains outside this bounded packet. */
  readonly requiredUserTransport?: { readonly kind: "indexed"; readonly availableSources: number; readonly shownSources: number;
    readonly omittedSources: number; readonly catalogRef: string };
}

export type SessionContentRead = {
  readonly ok: true;
  readonly value: { readonly batch: ContentMaterialBatch; readonly source: SessionContentSource;
    readonly taskPurpose: string; readonly coverage: SessionContentCoverage };
} | { readonly ok: false; readonly reason: string };

export interface SessionContentPage {
  readonly ok: true;
  readonly value: { readonly ref: string; readonly sessionId: string; readonly journalSequence: number;
    readonly sourceHash: string; readonly start: number; readonly end: number; readonly totalChars: number; readonly text: string;
    readonly origin: TopicEvidenceOrigin; readonly originalScope: string; readonly sourceRecordType: string;
    readonly coordinate?: { readonly runId: string; readonly sequence: number };
    readonly originalSource?: { readonly ref: string; readonly runId: string; readonly sequence: number; readonly sourceHash: string } };
}

export interface SessionContentSource extends ContentMaterialSource {
  readMaterial(ref: string, signal: AbortSignal, start?: number, maximumChars?: number): Promise<SessionContentPage | { readonly ok: false; readonly reason: string }>;
  listMaterials(signal: AbortSignal, request?: { readonly sessionId?: string; readonly start?: number; readonly maximumItems?: number }):
    Promise<{ readonly ok: true; readonly value: SessionMaterialCatalog } | { readonly ok: false; readonly reason: string }>;
}

export interface SessionMaterialCatalog {
  readonly sessionId: string;
  readonly available: number;
  readonly start: number;
  readonly nextStart: number | null;
  readonly entries: readonly { readonly ref: string; readonly address: string; readonly journalSequence: number;
    readonly turnId?: string; readonly role: string; readonly totalChars: number; readonly preview: string; readonly previewOmittedChars: number;
    readonly originalRef?: string; readonly originalSourceHash?: string }[];
}
