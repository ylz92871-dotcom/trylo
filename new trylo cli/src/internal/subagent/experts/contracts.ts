import type { SubagentRole } from "../role.js";

/** Experts specialize existing seats; they never introduce a second role system. */
export type ExpertBaseRole = "person" | "architect" | "worker" | "reviewer" | "verifier" | "cad-planner" | "cad-verifier";

export type ExpertSource = { readonly kind: "official" | "community" | "installed_skill" | "user";
  readonly title: string; readonly uri: string; readonly excerpt: string };

export type ExpertMethod = { readonly title: string; readonly instructions: string; readonly sourceUris: readonly string[] };

export type ExpertConfiguration = {
  readonly displayName: string;
  readonly specialty: string;
  readonly situations: readonly string[];
  readonly responsibilities: readonly string[];
  readonly constraints: readonly string[];
  readonly collaboration: readonly string[];
  readonly baseRole: ExpertBaseRole;
  readonly role: SubagentRole;
  /** References are declarations, not grants. Resolution is repeated at dispatch. */
  readonly toolRefs: readonly string[];
  readonly methods: readonly ExpertMethod[];
  readonly sources: readonly ExpertSource[];
};

export type ExpertIdentity = { readonly expertId: string; readonly version: number; readonly experienceKey: string;
  /** Uncommitted configurations need a discriminator; they are not saved versions. */
  readonly draft?: { readonly requestId: string; readonly revision: number } };

export type ExpertVersion = ExpertIdentity & { readonly configuration: ExpertConfiguration;
  readonly createdAt: number; readonly requestId: string };

export type ExpertRecord = { readonly expertId: string; readonly experienceKey: string;
  readonly status: "active" | "archived"; readonly versions: readonly ExpertVersion[] };

export type ExpertOrigin = "settings" | "personal_agent" | "collaboration";

export type ExpertRequestAssociation = { readonly issueId?: string; readonly jobId?: string; readonly grantId?: string; readonly correlationRef?: string };

export type ExpertUseScope = { readonly workspaceId: string; readonly taskId: string };

export type ExpertRequestState = "awaiting_creation" | "authorized" | "awaiting_retention" | "revision_requested" | "saved" | "temporary" | "rejected";

export type ExpertRequest = {
  readonly requestId: string; readonly expertId: string; readonly experienceKey: string;
  readonly origin: ExpertOrigin; readonly instruction: string; readonly baseVersion: number;
  readonly association?: ExpertRequestAssociation;
  readonly useScope?: ExpertUseScope;
  /** Missing in earlier v1 drafts means build. Direct manual revisions reuse existing expertise. */
  readonly preparation?: "build" | "reuse_configuration";
  readonly state: ExpertRequestState; readonly revision: number; readonly createdAt: number;
  readonly configuration?: ExpertConfiguration;
  /** Explicit edits remain authoritative when a builder proposes a revision. */
  readonly userEdits: Partial<ExpertConfiguration>;
  readonly feedback?: string;
  readonly creationAuthorization?: string; readonly retentionAuthorization?: string;
};

export type ExpertLibrarySnapshot = { readonly schemaVersion: 1; readonly sequence: number;
  readonly experts: readonly ExpertRecord[]; readonly requests: readonly ExpertRequest[] };

export const EXPERT_APPROVAL_REVIEW_MAX_BYTES = 96 * 1024;

export type ExpertAuthorizationAction = { readonly requestId: string; readonly stage: "create" | "retain" | "edit" | "archive";
  readonly fingerprint: string; readonly summary: string;
  /** Exact canonical request candidate/version reviewed by a trusted UI. Optional for older hosts. */
  readonly reviewJson?: string };

/** Only trusted host interaction context may carry userActionId, never model arguments. */
export type ExpertActionContext = { readonly signal?: AbortSignal; readonly userActionId?: string; readonly useScope?: ExpertUseScope };

export type ExpertAuthorizationPort = {
  authorize(action: ExpertAuthorizationAction, context: ExpertActionContext): Promise<
    { readonly resolution: "approved"; readonly receipt: string } | { readonly resolution: "denied" | "cancelled" | "expired" }>;
};

export type ExpertStorePort = {
  read(): ExpertLibrarySnapshot;
  /** Atomic compare-and-swap. Contention must fail, never silently overwrite. */
  update(expectedSequence: number, next: ExpertLibrarySnapshot): void;
};

export type ExpertBuildPort = {
  build(input: { readonly request: ExpertRequest; readonly previous?: ExpertConfiguration; readonly signal: AbortSignal }): Promise<ExpertConfiguration>;
};

export type ExpertToolResolution = { readonly ref: string } & (
  { readonly state: "resolved"; readonly toolNames: readonly string[] } |
  { readonly state: "pending" | "unavailable"; readonly reason: string });

export type ExpertToolPort = { resolve(refs: readonly string[], signal: AbortSignal): Promise<readonly ExpertToolResolution[]> };

export type ExpertExperiencePort = {
  /** Collaboration owns selection/content; expert library owns only stable attribution. */
  load(input: ExpertIdentity & { readonly task: string; readonly maxChars: number; readonly signal: AbortSignal }): Promise<string | {
    readonly text: string; readonly versionIds: readonly string[] }>;
};

export class ExpertLibraryError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "conflict" | "invalid_state" | "unauthorized" | "resource_unavailable" | "cancelled" | "store_unavailable", message: string) {
    super(message);
    this.name = "ExpertLibraryError";
  }
}
