import type { SessionPort } from "../../ports/session.js";
import type { LearningDomain } from "../../learning/control/contracts.js";
import type { ContentPacket } from "../../learning/central/content/material-contract.js";
import type { ContentProcessOutput } from "../../learning/central/content/process.js";
import type { ContentTaskRecallPort, ContentTaskReferenceCoverage } from "./sources/board-contract.js";
import type { SessionContentCoverage } from "./sources/session-contract.js";
import type { ContentPublication } from "./service.js";
import type { NativeKnowledgeAccess } from "./sources/native-knowledge.js";
import type { TaskSourcePageRead } from "./task-source-pages.js";
import type { ContentDomainFeedbackReader, DomainFeedbackMaterialCoverage } from "./sources/domain-feedback.js";
import type { ContentIssueAdmission } from "./admission.js";
import type { TaskCentralAdvisory } from "./sources/native-central-advisory.js";

export interface NormalTaskContentOptions {
  readonly boardRoot: string;
  readonly scope: string;
  readonly domain: LearningDomain;
  readonly session: Pick<SessionPort, "readRecords" | "append">;
  readonly sessionId: string;
  readonly turnId: string;
  readonly enabled: () => boolean;
  readonly now: () => number;
  readonly secrets?: readonly string[];
  readonly recall?: ContentTaskRecallPort;
  readonly excludeToolNames?: readonly string[];
  /** The host's canonical read-only session registry. Source adapters verify the original workspace. */
  readonly lookupSession?: (sessionId: string, signal: AbortSignal) => Promise<Pick<SessionPort, "readRecords"> | undefined>;
  /** Exact canonical task/turn lookup in the original registry; source adapters recheck journals and workspace. */
  readonly lookupSessionsForTask?: (taskId: string, signal: AbortSignal) => Promise<readonly string[]>;
  readonly nativeAccess?: NativeKnowledgeAccess;
  /** Pure original-owner projection, shared with worker context and content admission. */
  readonly domainFeedback?: ContentDomainFeedbackReader;
}

export interface NormalTaskContentPreparation {
  readonly packet: ContentPacket;
  readonly advisories?: readonly TaskCentralAdvisory[];
  readonly advisoryCatalog?: readonly TaskCentralAdvisory[];
  readonly coverage: { readonly session: SessionContentCoverage; readonly references: ContentTaskReferenceCoverage;
    readonly domainFeedback?: DomainFeedbackMaterialCoverage };
}

export type NormalTaskContentPrepared = { readonly ok: true; readonly value: NormalTaskContentPreparation }
  | { readonly ok: false; readonly reason: string };

export interface NormalTaskContentRuntime {
  readonly identity: Pick<NormalTaskContentOptions, "boardRoot" | "scope" | "domain" | "sessionId" | "turnId">;
  prepare(input: { readonly issueId?: string }, signal: AbortSignal): Promise<NormalTaskContentPrepared>;
  publish(packet: ContentPacket, output: ContentProcessOutput, expectedWriteRevision?: number): Promise<ContentPublication>;
  readMaterial(input: { readonly packet: ContentPacket; readonly evidenceRef: string; readonly start?: number; readonly maximumChars?: number },
    signal: AbortSignal): Promise<TaskSourcePageRead>;
  /** Optional on legacy injected runtimes; the normal runtime checks current original feedback before default replay. */
  currentAdmission?(issueId: string, signal: AbortSignal): Promise<ContentIssueAdmission>;
}
