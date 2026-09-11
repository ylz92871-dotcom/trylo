// Trylo Desktop — Service Host method + event catalog (renderer side).
//
// TS mirror of the sidecar's method registry (desktop-services/src/
// protocol/registry.mjs — see the "append here" note) plus the S→D event
// payloads. Every cross-process payload has an explicit type here; handlers
// above the adapter never touch raw JSON (spec §5.2 / §11).
//
// Phase 2 registers the pet domain; learning.* / remote.* append here as
// their Phases land.

import type { CompanionPublishPayload } from '../companion/companion-port';

// ── D→S request params/results ───────────────────────────────────────

export interface PetEnableParams {
  readonly workspacePath: string;
}

/** Stable, renderer-facing reason codes (audit §4.2 PET-P0-2). Mirrors
 *  `PET_REASON` in desktop-services/src/pet/pet-channel.mjs. The UI shows a
 *  FIXED string per code — the raw message is never surfaced, because it can
 *  carry a private absolute path. */
export type PetReasonCode =
  | 'not_attempted'
  | 'no_sidecars_dir'
  | 'bridge_module_missing'
  | 'exe_not_found'
  | 'spawn_failed'
  | 'spawn_no_pid'
  | 'unsupported_platform'
  | 'bridge_unavailable';

/** The real companion state. Every field is a FACT read back from the
 *  vendor bridge (audit §4.2 PET-P0-2) — `exeFound` is no longer
 *  `platform === 'win32'`. `exePath` is a basename, never a full path. */
export interface PetStatusSnapshot {
  readonly enabled: boolean;
  readonly exeFound: boolean;
  /** True once a launch was actually attempted. Distinguishes "never tried"
   *  (module preload, non-Windows) from "tried and failed". */
  readonly launchAttempted: boolean;
  readonly launched: boolean;
  readonly chatConnected: boolean;
  readonly exePath: string;
  readonly reasonCode: string;
}

export type PetEnableResult = PetStatusSnapshot & { readonly ok: boolean };

export interface PetDisableResult {
  readonly ok: boolean;
}

export type PetOpenChatResult = PetStatusSnapshot & { readonly ok: boolean };

export type PetStatusResult = PetStatusSnapshot;

export interface PetPublishResult {
  readonly ok: boolean;
}

/** Connection config for the pet chat LLM. Injected per request from the
 *  Desktop settings (spec §6.4: 配置来源改为 Desktop settings JSON). */
export interface ChatClientConfig {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly apiKeyHeader?: string;
  readonly apiKeyPrefix?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly taskTimeoutMinutes?: number;
  readonly thinkingBudget?: number;
  readonly extraHeadersText?: string;
  readonly providerId?: string;
}

/** A chat request mirrored off the bridge (chat_send / chat_history_request
 *  / chat_clear / chat_cancel), mode already gated to 'chat'. */
export interface PetChatRequestMessage {
  readonly type: string;
  readonly requestId: string;
  readonly mode?: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

export interface PetChatHandleParams {
  readonly message: PetChatRequestMessage;
  readonly chat?: ChatClientConfig;
}

export interface PetChatHandleResult {
  readonly ok: boolean;
  readonly error?: string;
}

// ── learning domain (Phase 3) ────────────────────────────────────────
// Types mirror the Service Host handlers in
// desktop-services/src/learning/index.mjs (spec §7.5). Read-only queries
// degrade to `{ ok:false, error }`; staged writes are fail-closed — `apply`
// REQUIRES both a pendingId and the expectedHash the user reviewed
// (arch §6.3).

export type HermesMcpProfile = 'normal' | 'learning' | 'history';

export interface LearningHealthResult {
  readonly ok: boolean;
  readonly available: boolean;
  readonly storageRoot?: string;
  readonly hermesHome?: string;
  readonly hermesHomeReady?: boolean;
  readonly pythonExe?: string;
  readonly serverScript?: string;
  readonly serverScriptFound?: boolean;
  readonly reason?: string | null;
  readonly installHint?: string;
}

/** MCP args handed to the Trylo CLI verbatim — the allowlists stay
 *  authoritative in the vendored Hermes manager, never re-declared here. */
export interface LearningMcpArgsParams {
  readonly profile?: HermesMcpProfile;
}

export interface LearningMcpArgsResult {
  readonly ok: boolean;
  readonly profile: string;
  readonly arg: readonly string[];
  readonly warning: string | null;
  readonly allowedTools?: readonly string[];
  readonly configPath?: string | null;
  readonly hermesHome?: string | null;
}

/** Opaque-by-design: the Memory snapshot shape belongs to Hermes. Desktop
 *  passes it through to the Learning UI and branches only on `ok`. */
export interface LearningMemorySnapshotResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export interface LearningSkillsParams {
  readonly op?: 'list' | 'view';
  readonly name?: string;
}

export interface LearningSkillsResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly op?: string;
  readonly skills?: readonly Record<string, unknown>[];
  readonly content?: string;
  readonly [key: string]: unknown;
}

/** The projected conversation handed to the Hermes session mirror
 *  (spec §1 / §7.4 — built by session-projection.ts). */
export interface LearningSessionProjection {
  readonly id: string;
  readonly title: string;
  readonly workspace: { readonly path: string };
  readonly model?: string;
  readonly turns: readonly {
    readonly prompt: string;
    readonly resultText: string;
    readonly startedAt?: string;
    readonly events?: readonly LearningRunEventSummary[];
  }[];
}

export interface LearningSessionSyncParams {
  readonly session: LearningSessionProjection;
}

export interface LearningSessionSyncResult {
  readonly ok: boolean;
  readonly mirrored: boolean;
  readonly error?: string;
}

export interface LearningSessionRebuildParams {
  readonly sessions: readonly LearningSessionProjection[];
}

export interface LearningSessionRebuildResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

export interface LearningSessionFlushResult {
  readonly ok: boolean;
  readonly stopped?: boolean;
}

export type PendingSubsystem = 'memory' | 'skills';

export interface LearningPendingListResult {
  readonly ok: boolean;
  readonly pending: readonly Record<string, unknown>[];
  readonly count: number;
  readonly error?: string | null;
}

export interface LearningPendingDetailParams {
  readonly subsystem: PendingSubsystem;
  readonly id: string;
}

export interface LearningPendingDetailResult {
  readonly ok: boolean;
  readonly detail?: Record<string, unknown>;
  readonly error?: string | null;
}

export interface LearningPendingApplyParams {
  /** Memory and Skill proposals share one approval surface, but their
   *  commit paths are different. The reviewed subsystem must therefore be
   *  carried with the id instead of being guessed by the Service Host. */
  readonly subsystem: PendingSubsystem;
  readonly id: string;
  /** Hash the user reviewed. Required — an apply without it is rejected
   *  before Python is ever spawned (anti-swap, arch §6.3). */
  readonly expectedHash: string;
  readonly reason?: string;
}

export interface LearningPendingMutationResult {
  readonly ok: boolean;
  readonly result?: Record<string, unknown> | null;
  readonly error?: string | null;
}

// ── PR-6 template copy (spec §2.8 / §5) ─────────────────────────────────
// The apply-time privileged copy of a deliverable into the Skill tree. The
// copyPlan is fixed at review time; apply only reads it (never re-scans
// `.trylo/out` as the source of truth, spec §2.8). The sidecar enforces the
// allowlist / symlink / size / hash guards; the renderer never resolves paths.

export interface LearningCopyTemplateParams {
  /** Workspace root the `.trylo/out` deliverable lives under. */
  readonly workspaceRoot: string;
  /** `.trylo/out/<sourceRel>` relative path (POSIX-slash). */
  readonly sourceRel: string;
  /** Absolute destination `{HERMES_HOME}/skills/<skillName>/templates/<slug>.pptx`
   *  as projected by the renderer. The sidecar re-validates its shape. */
  readonly destAbs: string;
  /** Expected size in bytes, captured at review time. Mismatch → skip copy. */
  readonly expectedBytes?: number;
  /** Expected mtime in ms, captured at review time. >10% drift → skip copy. */
  readonly expectedMtimeMs?: number;
}

export type LearningCopyTemplateResult =
  | { readonly ok: true; readonly copied: true; readonly destAbs: string; readonly bytes: number }
  | { readonly ok: true; readonly copied: false; readonly reasonCode: string; readonly destAbs?: string }
  | { readonly ok: false; readonly error: string };

export interface LearningPendingDiscardParams {
  readonly subsystem: PendingSubsystem;
  readonly id: string;
}

export interface LearningPendingBackupsResult {
  readonly ok: boolean;
  readonly backups: readonly Record<string, unknown>[];
  readonly error?: string | null;
}

export interface LearningPendingRollbackParams {
  readonly snapshotId: string;
}

// ── learning loop (Phase 3C, spec §7.6) ──────────────────────────────
// A review runs a SEPARATE invisible CLI turn. Only the evidence capsule is
// sent — never the user's prompt and never the raw event log (arch §6.5).

/** Structured, already-redacted run event. The renderer decides what goes in;
 *  the sidecar persists nothing but the capsule. */
export interface LearningRunEventSummary {
  readonly id?: string;
  readonly category?: string;
  readonly title?: string;
  readonly status?: string;
  readonly iterations?: number;
}

/** Learning knobs. Defaults live in the legacy orchestrator — Desktop only
 *  supplies what the user configured (spec §6.4). */
export interface LearningConfig {
  readonly enabled?: boolean;
  readonly creationNudgeInterval?: number;
}

/** CLI connection used by the shadow (invisible) learning run. */
export interface LearningCliConfig {
  readonly cliPath: string;
  readonly cwd: string;
  readonly apiKey?: string;
  readonly apiHost?: string;
  readonly apiModel?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly apiKeyHeader?: string;
  readonly apiKeyPrefix?: string;
  readonly extraHeadersText?: string;
}

export interface LearningReviewParams {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly mode?: 'agent' | 'office';
  /** Result text of the finished turn (evidence only). */
  readonly resultText?: string;
  readonly taskGoal?: string;
  readonly interrupted?: boolean;
  readonly hasPendingReview?: boolean;
  readonly events?: readonly LearningRunEventSummary[];
  readonly fileHints?: readonly string[];
  readonly verification?: readonly string[];
  readonly config?: LearningConfig;
  readonly cli?: LearningCliConfig;
  readonly timeoutMs?: number;
}

export interface LearningReviewResult {
  readonly ok: boolean;
  readonly status?: string;
  readonly candidateId?: string;
  readonly pendingId?: string;
  readonly reason?: string;
  readonly reasonCode?: string;
  readonly error?: string;
}

export interface LearningExplicitParams extends LearningReviewParams {
  /** The user's /learn instruction. */
  readonly learnRequest: string;
}

export interface LearningRunStatusParams {
  readonly workspaceRoot?: string | null;
}

export interface LearningRunStatusResult {
  readonly ok: boolean;
  readonly active: boolean;
  readonly run: {
    readonly workspace: string;
    readonly active: boolean;
    readonly candidateId?: string;
    readonly status?: string;
    readonly mode?: string;
    readonly startedAt?: number;
  } | null;
}

export interface LearningHistorySearchParams {
  readonly queries: readonly string[];
  readonly limit?: number;
}

export interface LearningHistorySearchResult {
  readonly ok: boolean;
  readonly results?: readonly Record<string, unknown>[];
  readonly queryPlan?: unknown;
  readonly truncated?: boolean;
  readonly error?: string;
}

/** Safe projection of the official Hermes learning graph. Memory bodies are
 * never included; the Python adapter owns the projection contract. */
export interface LearningGraphSummaryResult {
  readonly ok: boolean;
  readonly graph?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface LearningQualityScanParams {
  readonly thresholds?: Readonly<Record<string, number>>;
  readonly scope?: { readonly skillNames?: readonly string[] };
  readonly timeoutMs?: number;
}

export interface LearningQualityCandidate {
  readonly a: string;
  readonly b: string;
  readonly reason: string;
  readonly scores: { readonly name: number; readonly desc: number; readonly category: number };
  readonly hardRejects: readonly string[];
}

export interface LearningQualityScanResult {
  readonly ok: boolean;
  readonly signals: number;
  readonly candidates: readonly LearningQualityCandidate[];
  readonly graph?: Readonly<Record<string, unknown>>;
  readonly stats?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface LearningHistoryMineParams {
  readonly workspaceRoot: string;
  readonly workspaceLabel?: string;
  readonly currentTask?: Readonly<Record<string, unknown>>;
  readonly cli?: LearningCliConfig;
  readonly timeoutMs?: number;
}

export interface LearningHistoryMineResult {
  readonly ok: boolean;
  readonly status: string;
  readonly candidates: readonly Record<string, unknown>[];
  readonly errors: readonly { readonly code: string; readonly message: string }[];
}

export type LearningJobType =
  | 'index-rebuild'
  | 'backup-verify'
  | 'graph-refresh'
  | 'history-mining'
  | 'quality-scan';

export interface LearningJobsParams {
  readonly action?: 'list' | 'register' | 'remove' | 'enable' | 'disable' | 'runNow';
  readonly jobId?: string;
  readonly type?: LearningJobType;
  readonly enabled?: boolean;
  readonly intervalMs?: number;
  readonly budgetModelCalls?: number;
  readonly scopeWorkspace?: string | null;
  readonly workspaceRoot?: string;
  readonly workspaceLabel?: string;
  readonly currentTask?: Readonly<Record<string, unknown>>;
  readonly sessions?: readonly LearningSessionProjection[];
  readonly cli?: LearningCliConfig;
  readonly timeoutMs?: number;
}

export interface LearningJobsResult {
  readonly ok: boolean;
  readonly jobs?: readonly Record<string, unknown>[];
  readonly runs?: readonly Record<string, unknown>[];
  readonly inflightRunIds?: readonly string[];
  readonly degraded?: boolean;
  readonly job?: Readonly<Record<string, unknown>>;
  readonly errorCode?: string | null;
  readonly error?: string;
}

// ── legacy data import (spec §7.5) ───────────────────────────────────
// discover → copy (never overwrite) → verify → mark imported. Re-runnable;
// the old VS Code location is never deleted.

export interface LegacyImportCandidate {
  readonly source: string;
  readonly hermesHome: string;
  readonly files: number;
  readonly bytes: number;
}

export interface LegacyImportPlanResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly candidates: readonly LegacyImportCandidate[];
  readonly target: {
    readonly hermesHome: string;
    readonly files: number;
    readonly bytes: number;
  };
  readonly alreadyImported: {
    readonly importedAt: string;
    readonly source: string;
  } | null;
}

export interface LegacyImportCommitParams {
  readonly source: string;
}

export interface LegacyImportCommitResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly skipped?: boolean;
  readonly copied?: number;
  readonly skippedFiles?: number;
  readonly verified?: boolean;
  readonly sourceFiles?: number;
  readonly targetFiles?: number;
}

// ── remote domain (Phase 4, spec §8.1) ───────────────────────────────
// Types mirror the Service Host handlers in
// desktop-services/src/remote/index.mjs. Desktop owns every gateway handler;
// the sidecar forwards invocations as `host.remoteRequest` events and the
// Desktop answers through `remote.respond`. The projection pushes
// `remote.publish` events into the gateway's in-memory snapshot (arch §7.3).

export type RemoteTunnelMode = 'named' | 'quick' | 'manual';

export interface RemoteStatusResult {
  readonly ok: boolean;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly port: number;
  readonly publicUrl: string;
  readonly tunnelMode: RemoteTunnelMode | 'off';
  readonly tunnelRunning: boolean;
  readonly reasonCode: string;
}

export interface RemoteEnableParams {
  readonly port?: number;
  readonly workspaceName?: string;
  readonly deviceName?: string;
  readonly tunnelMode?: RemoteTunnelMode | 'off';
  readonly publicUrl?: string;
  readonly cloudflaredPath?: string;
  readonly tunnelTimeoutMs?: number;
}

export type RemoteEnableResult = RemoteStatusResult;

export interface RemoteDisableResult {
  readonly ok: boolean;
}

/** A gateway `publish()` event (gateway state machine, vendor
 *  remote-gateway/index.js). The projection emits these — the shapes are
 *  the gateway's, never re-invented here. */
export interface RemoteAgentStateEvent {
  readonly type: 'agentState';
  readonly state: string;
  readonly detail?: string;
  readonly level?: string;
  readonly meta?: { readonly progress?: number };
  readonly mode?: string;
  readonly at?: number;
}
export interface RemoteTraceEvent {
  readonly type: 'trace';
  readonly id?: string;
  readonly title?: string;
  readonly detail?: string;
  readonly text?: string;
  readonly kind?: string;
  readonly phase?: string;
  readonly mode?: string;
  readonly at?: number;
}
export interface RemoteAssistantEvent {
  readonly type: 'assistant';
  readonly text?: string;
  readonly turnId?: string;
  readonly mode?: string;
  readonly at?: number;
}
export interface RemoteErrorEvent {
  readonly type: 'error';
  readonly message: string;
  readonly at?: number;
}
export interface RemoteStoppedEvent {
  readonly type: 'stopped';
  readonly at?: number;
}
export interface RemoteModeStateEvent {
  readonly type: 'modeState';
  readonly mode: string;
}
export interface RemoteProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly lastSeenAt?: number;
}
export interface RemoteProjectsStateEvent {
  readonly type: 'projectsState';
  readonly projects: readonly RemoteProjectSummary[];
  readonly activeProjectId: string;
}
export interface RemoteTurnStartedEvent {
  readonly type: 'turnStarted';
  readonly turn: {
    readonly id?: string;
    readonly prompt?: string;
    readonly startedAt?: number;
    readonly mode?: string;
  };
  readonly at?: number;
}
export interface RemoteTurnEventEvent {
  readonly type: 'turnEvent';
  readonly turnId?: string;
  readonly event: {
    readonly id?: string;
    readonly category?: string;
    readonly kind?: string;
    readonly title?: string;
    readonly detail?: string;
    readonly rawDetail?: string;
    readonly at?: number;
    readonly status?: string;
  };
  readonly at?: number;
}
export interface RemoteIdeStreamTextEvent {
  readonly type: 'ideStreamText';
  readonly turnId?: string;
  readonly delta: string;
  readonly at?: number;
}
export interface RemoteIdeStreamThinkingEvent {
  readonly type: 'ideStreamThinking';
  readonly turnId?: string;
  readonly delta: string;
  readonly at?: number;
}
export interface RemoteTurnFinishedEvent {
  readonly type: 'turnFinished';
  readonly turn: {
    readonly id?: string;
    readonly resultText?: string;
    readonly completedAt?: number;
    readonly mode?: string;
  };
  readonly at?: number;
}
export interface RemoteSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly preview?: string;
  readonly updatedAt?: number;
  readonly workspace?: {
    readonly id?: string;
    readonly name?: string;
    readonly path?: string;
  } | null;
}
export interface RemoteSessionStateEvent {
  readonly type: 'sessionState';
  readonly activeSessionId: string;
  readonly sessions: readonly RemoteSessionSummary[];
  readonly at?: number;
}
export interface RemotePermissionSummary {
  readonly requestId: string;
  readonly category?: string;
  readonly title: string;
  readonly detail?: string;
  readonly description?: string;
  readonly toolName?: string;
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly risk?: 'low' | 'medium' | 'high';
  readonly requestedAt?: number;
}
export interface RemotePermissionRequestStateEvent {
  readonly type: 'permissionRequestState';
  readonly requests: readonly RemotePermissionSummary[];
  readonly at?: number;
}

export type RemoteGatewayEvent =
  | RemoteAgentStateEvent
  | RemoteTraceEvent
  | RemoteAssistantEvent
  | RemoteErrorEvent
  | RemoteStoppedEvent
  | RemoteModeStateEvent
  | RemoteProjectsStateEvent
  | RemoteTurnStartedEvent
  | RemoteTurnEventEvent
  | RemoteIdeStreamTextEvent
  | RemoteIdeStreamThinkingEvent
  | RemoteTurnFinishedEvent
  | RemoteSessionStateEvent
  | RemotePermissionRequestStateEvent;

export interface RemotePublishResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Pairing payload the phone parses (protocol 1 — gateway.ts unchanged). */
export interface RemotePairing {
  readonly protocol: 1;
  readonly service: 'trylo-remote';
  readonly deviceId: string;
  readonly deviceName: string;
  readonly workspaceName: string;
  readonly baseUrl: string;
  readonly token: string;
}

export interface RemotePairingInfoResult {
  readonly pairing: RemotePairing;
  readonly qrDataUrl: string;
}

/** The Desktop's answer to a forwarded gateway handler invocation
 *  (host.remoteRequest → remote.respond). */
export interface RemoteRespondParams {
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly statusCode?: number };
}

export interface RemoteRespondResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Stream an action_event back to mobile on behalf of an in-flight handler. */
export interface RemoteEmitParams {
  readonly requestId: string;
  readonly payload: unknown;
}

export interface RemoteEmitResult {
  readonly ok: boolean;
}

export interface RemoteImportIdentityParams {
  /** Legacy globalStorage dir holding remote-identity.json (spec §7.6). */
  readonly legacyDir?: string;
}

export interface RemoteImportIdentityResult {
  readonly imported: boolean;
  readonly skipped: boolean;
  readonly reason?: string;
}

// ── tooling domain (Trylo Tool Platform, spec §3/§4/§9) ──────────────
// Types mirror desktop-services/src/tooling/index.mjs. The renderer asks the
// sidecar to COMPOSE a Profile; it never builds an MCP config itself, and it
// never decides what a package means (§3.1).

export type ToolSurface = 'code' | 'work';

/** Why a tool package is not contributing tools this run (§4.4). */
export type ToolUnavailableReasonCode =
  | 'not_in_catalog'
  | 'not_installed'
  | 'version_mismatch'
  | 'server_name_collision'
  | 'hermes_unavailable';

/** Why a package is not contributing tools this run (§4.4). */
export type ToolPackageState =
  | 'installed'
  | 'not-installed'
  | 'hash-mismatch'
  | 'version-mismatch'
  | 'condition-missing'
  | 'override';

/** A runtime condition beyond the package itself (§3.3-7): playwright's
 *  browser body, today. Absent when the manifest declares none. */
export interface ToolPackageCondition {
  readonly ok: boolean;
  readonly reasonCode: string;
  readonly detail: string;
}

export interface ToolPackageHealth {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly adoption: 'stable' | 'trial' | 'developer';
  readonly serverName: string;
  readonly state: ToolPackageState;
  readonly available: boolean;
  readonly detail: string;
  readonly autoUpdate: boolean;
  readonly expectedTools: readonly string[];
  /** `tools/list` verification is owned by the CLI run, not the sidecar
   *  (§8.1 forbids the Service Host from spawning the CLI's MCP servers). */
  readonly protocol: 'not-checked' | 'ok' | 'drift';
  readonly checkedAt: number;
  readonly reportedVersion: string | null;
  readonly versionMatches: boolean | null;
  /** §3.3-7: runtime condition beyond the package (browser body). Present
   *  only for manifests that declare `browserCondition`. */
  readonly condition?: ToolPackageCondition;
}

export interface ToolUnavailableCapability {
  readonly id: string;
  readonly type: 'package' | 'adapter';
  readonly displayName?: string;
  readonly version?: string;
  readonly reasonCode: ToolUnavailableReasonCode;
  readonly detail?: string;
  /** Fixed, UI-ready text. The raw detail may carry absolute paths and is
   *  never rendered verbatim in a chat bubble. */
  readonly userMessage: string;
}

export interface ToolingResolveProfileParams {
  readonly surface: ToolSurface;
  readonly requestedProfileId?: string;
  readonly projectKey?: string;
  readonly projectRoot?: string;
  readonly conversationId?: string;
}

/** The composed runtime contract for ONE run (spec §4.2). */
export interface ResolvedToolRuntime {
  readonly profileId: string;
  readonly profileRevision: string;
  readonly surface: ToolSurface;
  readonly mcpConfigPath: string | null;
  readonly mcpConfigHash: string;
  readonly permissionSettingsPath: string | null;
  readonly permissionSettingsHash: string;
  readonly cliArgs: readonly string[];
  readonly spawnEnv: Readonly<Record<string, string>>;
  readonly serverNames: readonly string[];
  readonly packageHealth: readonly ToolPackageHealth[];
  readonly unavailableCapabilities: readonly ToolUnavailableCapability[];
  readonly strictMcpConfig: boolean;
  readonly resolvedAt: number;
}

export type ToolingResolveProfileResult = { readonly ok: true } & ResolvedToolRuntime;
export interface ToolingResolveProfileFailure {
  readonly ok: false;
  readonly reasonCode:
    | 'unknown_profile'
    | 'profile_surface_mismatch'
    | 'no_storage_root'
    | 'config_write_failed';
  readonly error?: string;
  readonly knownProfiles?: readonly string[];
}

export interface ToolingHealthParams {
  readonly id?: string;
}

export interface ToolingHealthResult {
  readonly ok: boolean;
  readonly installRoot: string;
  readonly profilesRoot: string;
  readonly rejected: readonly { readonly id: string; readonly problems: readonly string[] }[];
  readonly packages: readonly ToolPackageHealth[];
}

export interface ToolingProfileSummary {
  readonly id: string;
  readonly revision: string;
  readonly surface: ToolSurface;
  readonly packageIds: readonly string[];
  readonly strictMcpConfig: boolean;
}

export interface ToolingListProfilesResult {
  readonly ok: boolean;
  readonly profiles: readonly ToolingProfileSummary[];
}

export interface ToolingInstallParams {
  readonly id: string;
  /** Local artefact path (air-gapped/dev flow). When omitted, the sidecar
   *  downloads the manifest's pinned `artifact.downloadUrl` and verifies the
   *  digest before placement (PR-2 network transport). */
  readonly archivePath?: string;
}

export interface ToolingInstallResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly version?: string;
  readonly installDir?: string;
  readonly executable?: string;
  readonly reasonCode?: string;
  readonly error?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface ToolingUninstallParams {
  readonly id: string;
}

export interface ToolingUninstallResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly version?: string;
  readonly removed?: string;
  readonly reasonCode?: string;
}

/** §3.3-7: install the browser body a package's browserCondition needs
 *  (playwright → pinned chromium). The condition probe is the authority on
 *  success; this result only reports the attempt. */
export interface ToolingInstallBrowserParams {
  readonly id: string;
}

export interface ToolingInstallBrowserResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly reasonCode?: string;
  readonly error?: string;
}

// ── PR-3: runtime artifact promotion (spec §6.5 / §7.3) ──────────────
// A package's per-conversation runtime dir (.trylo/runtime/<dir>/<conv>) is
// a controlled TEMP zone; `.trylo/out/` is the only deliverable root. The
// sidecar's artifact promoter is the only path between them.

export interface ToolingListRuntimeArtifactsParams {
  readonly projectRoot: string;
  readonly conversationId: string;
  /** Catalog package id (e.g. 'playwright'). */
  readonly packageId: string;
}

export interface ToolingRuntimeArtifact {
  /** Path relative to the conversation's runtime dir, forward slashes. */
  readonly name: string;
  readonly size: number;
  readonly modifiedAt: number;
}

export interface ToolingListRuntimeArtifactsResult {
  readonly ok: boolean;
  readonly reasonCode?: string;
  readonly root?: string;
  readonly artifacts?: readonly ToolingRuntimeArtifact[];
}

export interface ToolingPromoteArtifactParams {
  readonly projectRoot: string;
  readonly conversationId: string;
  readonly packageId: string;
  /** Artifact path relative to the runtime dir (no `..`, no absolutes). */
  readonly fileName: string;
  /** Optional deliverable name inside .trylo/out (validated like fileName). */
  readonly targetName?: string;
}

export interface ToolingPromoteArtifactResult {
  readonly ok: boolean;
  readonly reasonCode?: string;
  readonly error?: string;
  readonly source?: string;
  readonly target?: string;
  readonly size?: number;
  readonly sha256?: string | null;
  readonly promotedAt?: number;
}

/** PR-4 (§7.1): one BinaryRef tool-cache TTL sweep (24 h default). */
export interface ToolingSweepToolCacheResult {
  readonly ok: boolean;
  readonly reasonCode?: string;
  readonly root: string | null;
  readonly removed: number;
  readonly scanned: number;
}

// ── PR-5: Office delivery validation (spec §11) ────────────────────────
// 「验证工具不必都暴露成 MCP，确定性 host pipeline 更可靠」(§11): the pipeline
// lives on the Service Host and is driven by the Work result lifecycle. The
// verdict is DELIVERY metadata — it never enters the agent's answer.

export type ToolingOfficeCheckId =
  | 'file-present'
  | 'container-match'
  | 'structure'
  | 'officecli-validate'
  | 'libreoffice-roundtrip';

export type ToolingOfficeCheckStatus = 'passed' | 'failed' | 'skipped';

/** `verified` 已验证 · `partial` 部分验证 · `failed` 验证失败 ·
 *  `skipped` 未验证（非 Office 文件 / 预算耗尽 / 无可用能力）。 */
export type ToolingOfficeArtifactStatus = 'verified' | 'partial' | 'failed' | 'skipped';

export interface ToolingOfficeValidationCapabilitiesResult {
  readonly ok: boolean;
  readonly checkedAt: number;
  readonly officecli: {
    readonly available: boolean;
    readonly version: string | null;
    readonly reasonCode: string | null;
  };
  readonly libreoffice: {
    readonly available: boolean;
    readonly version: string | null;
    readonly reasonCode: string | null;
  };
}

export interface ToolingValidateOfficeArtifactsParams {
  readonly projectRoot: string;
  /** Deliverable paths, project-relative (as the scanner recorded them). */
  readonly artifacts: readonly {
    readonly id: string;
    readonly relativePath: string;
  }[];
}

export interface ToolingOfficeValidationCheck {
  readonly id: ToolingOfficeCheckId;
  readonly status: ToolingOfficeCheckStatus;
  readonly reasonCode?: string;
  readonly detail?: string;
}

export interface ToolingOfficeArtifactValidation {
  readonly id: string;
  readonly relativePath: string;
  readonly status: ToolingOfficeArtifactStatus;
  readonly checks: readonly ToolingOfficeValidationCheck[];
  /** Why a check did not run, e.g. `officecli:not_installed` (§4.4). */
  readonly skippedCapabilities: readonly string[];
  readonly reasonCode?: string;
  readonly checkedAt: number;
}

export interface ToolingValidateOfficeArtifactsResult {
  readonly ok: boolean;
  readonly reasonCode?: string;
  readonly capabilities: ToolingOfficeValidationCapabilitiesResult;
  readonly checkedAt: number;
  readonly budgetExceeded: boolean;
  readonly results: readonly ToolingOfficeArtifactValidation[];
}

// ── S→D event payloads ───────────────────────────────────────────────

export interface PermissionDecisionEvent {
  readonly requestId: string;
  readonly decision: 'allow' | 'deny';
}

/** The embedded browser panel's state machine push
 *  (`tooling.viewportStatus`): stopped/starting/running/error + detail. */
export interface ViewportStatusEvent {
  readonly state: 'stopped' | 'starting' | 'running' | 'error';
  readonly detail?: string;
  readonly url?: string;
}

/** One `Page.screencastFrame` relayed as a `tooling.viewportFrame` event:
 *  a base64 JPEG plus the frame metadata the panel needs for input mapping. */
export interface ViewportFrameEvent {
  readonly data: string;
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  readonly pageScaleFactor: number;
}

/** The panel browser's coordinates for the URL bar / status line. */
export interface ViewportStartResult {
  readonly ok: boolean;
  readonly reasonCode?: string;
  readonly error?: string;
  readonly cdpPort?: number;
  readonly url?: string;
  readonly alreadyRunning?: boolean;
}

export interface ViewportNavigateResult {
  readonly ok: boolean;
  readonly reasonCode?: string;
  readonly error?: string;
  readonly url?: string;
}

export interface ViewportInputParams {
  readonly kind: 'mouse' | 'wheel' | 'key';
  /** normalized [0..1] against the latest frame */
  readonly x?: number;
  readonly y?: number;
  readonly action?: 'moved' | 'pressed' | 'released';
  readonly button?: 'left' | 'right';
  /** wheel delta, normalized ticks */
  readonly deltaY?: number;
  /** printable key text (≤16 chars) */
  readonly text?: string;
}

export interface ViewportInputResult {
  readonly ok: boolean;
  readonly reasonCode?: string;
  readonly error?: string;
}

export interface ViewportStopResult {
  readonly ok: boolean;
}

/** `pet.status` event payload. Same shape as the `pet.status` query result
 *  (audit §4.2 PET-P0-1): one shape, two delivery paths. */
export type PetStatusEvent = PetStatusSnapshot;

/** A chat_* protocol frame emitted back to the WPF window, mirrored for
 *  observability. The Desktop never branches on chat bodies (spec §11:
 *  禁止记录聊天正文 — consumers must not log payloads). */
export type PetChatEmitEvent = Readonly<Record<string, unknown>>;

export interface ReadyEvent {
  readonly version?: string;
}

export interface ServiceHostExitEvent {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly reasonCode: 'servicehost_exited' | 'servicehost_heartbeat_timeout';
}

/** A gateway handler invocation forwarded by the sidecar; the Desktop owns
 *  every handler and answers via `remote.respond` (arch §7.2). `name` is one
 *  of projects/project/session/task/cancel/permission/chat. */
export interface RemoteRequestEvent {
  readonly requestId: string;
  readonly name: string;
  readonly payload: unknown;
}

/** `remote.status` push (diagnostics; same shape as the query result). */
export type RemoteStatusEvent = RemoteStatusResult;

export interface ServiceEventMap {
  readonly 'host.permissionDecision': PermissionDecisionEvent;
  readonly 'host.petChat': PetChatRequestMessage;
  readonly 'host.remoteRequest': RemoteRequestEvent;
  readonly 'pet.status': PetStatusEvent;
  readonly 'remote.status': RemoteStatusEvent;
  readonly petChatEmit: PetChatEmitEvent;
  readonly ready: ReadyEvent;
  readonly 'servicehost.exit': ServiceHostExitEvent;
  readonly 'tooling.viewportFrame': ViewportFrameEvent;
  readonly 'tooling.viewportStatus': ViewportStatusEvent;
}

export type ServiceEventTopic = keyof ServiceEventMap;

// ── method table (name → params/result) ──────────────────────────────

export interface ServiceMethodMap {
  readonly 'pet.enable': { params: PetEnableParams; result: PetEnableResult };
  readonly 'pet.disable': { params: undefined; result: PetDisableResult };
  readonly 'pet.openChat': { params: undefined; result: PetOpenChatResult };
  readonly 'pet.status': { params: undefined; result: PetStatusResult };
  readonly 'pet.publish': { params: CompanionPublishPayload; result: PetPublishResult };
  readonly 'pet.chatHandle': { params: PetChatHandleParams; result: PetChatHandleResult };
  // Learning domain (Phase 3, spec §7.5). 3C appends here.
  readonly 'learning.health': { params: undefined; result: LearningHealthResult };
  readonly 'learning.mcpArgs': { params: LearningMcpArgsParams; result: LearningMcpArgsResult };
  readonly 'learning.memorySnapshot': { params: undefined; result: LearningMemorySnapshotResult };
  readonly 'learning.skills': { params: LearningSkillsParams; result: LearningSkillsResult };
  readonly 'session.sync': { params: LearningSessionSyncParams; result: LearningSessionSyncResult };
  readonly 'session.rebuild': { params: LearningSessionRebuildParams; result: LearningSessionRebuildResult };
  readonly 'session.flush': { params: undefined; result: LearningSessionFlushResult };
  readonly 'learning.pendingList': { params: undefined; result: LearningPendingListResult };
  readonly 'learning.pendingDetail': { params: LearningPendingDetailParams; result: LearningPendingDetailResult };
  readonly 'learning.pendingApply': { params: LearningPendingApplyParams; result: LearningPendingMutationResult };
  readonly 'learning.pendingDiscard': { params: LearningPendingDiscardParams; result: LearningPendingMutationResult };
  readonly 'learning.pendingBackupList': { params: undefined; result: LearningPendingBackupsResult };
  readonly 'learning.pendingRollback': { params: LearningPendingRollbackParams; result: LearningPendingMutationResult };
  readonly 'learning.copyTemplateUnderOut': { params: LearningCopyTemplateParams; result: LearningCopyTemplateResult };
  // 3C learning loop (spec §7.6).
  readonly 'learning.reviewImplicit': { params: LearningReviewParams; result: LearningReviewResult };
  readonly 'learning.learnExplicit': { params: LearningExplicitParams; result: LearningReviewResult };
  readonly 'learning.runStatus': { params: LearningRunStatusParams; result: LearningRunStatusResult };
  readonly 'learning.historySearch': { params: LearningHistorySearchParams; result: LearningHistorySearchResult };
  readonly 'learning.graphSummary': { params: undefined; result: LearningGraphSummaryResult };
  readonly 'learning.qualityScan': { params: LearningQualityScanParams; result: LearningQualityScanResult };
  readonly 'learning.historyMine': { params: LearningHistoryMineParams; result: LearningHistoryMineResult };
  readonly 'learning.jobs': { params: LearningJobsParams; result: LearningJobsResult };
  // Legacy data import (spec §7.5).
  readonly 'learning.importPlan': { params: undefined; result: LegacyImportPlanResult };
  readonly 'learning.importCommit': { params: LegacyImportCommitParams; result: LegacyImportCommitResult };
  // Remote domain (Phase 4, spec §8.1).
  readonly 'remote.status': { params: undefined; result: RemoteStatusResult };
  readonly 'remote.enable': { params: RemoteEnableParams; result: RemoteEnableResult };
  readonly 'remote.disable': { params: undefined; result: RemoteDisableResult };
  readonly 'remote.publish': { params: RemoteGatewayEvent; result: RemotePublishResult };
  readonly 'remote.pairingInfo': { params: undefined; result: RemotePairingInfoResult };
  readonly 'remote.respond': { params: RemoteRespondParams; result: RemoteRespondResult };
  readonly 'remote.emit': { params: RemoteEmitParams; result: RemoteEmitResult };
  readonly 'remote.importIdentity': { params: RemoteImportIdentityParams; result: RemoteImportIdentityResult };
  // Tooling domain (Trylo Tool Platform, spec §12.2).
  readonly 'tooling.resolveProfile': { params: ToolingResolveProfileParams; result: ToolingResolveProfileResult | ToolingResolveProfileFailure };
  readonly 'tooling.health': { params: ToolingHealthParams; result: ToolingHealthResult };
  readonly 'tooling.listProfiles': { params: undefined; result: ToolingListProfilesResult };
  readonly 'tooling.install': { params: ToolingInstallParams; result: ToolingInstallResult };
  readonly 'tooling.uninstall': { params: ToolingUninstallParams; result: ToolingUninstallResult };
  readonly 'tooling.installBrowser': { params: ToolingInstallBrowserParams; result: ToolingInstallBrowserResult };
  readonly 'tooling.listRuntimeArtifacts': { params: ToolingListRuntimeArtifactsParams; result: ToolingListRuntimeArtifactsResult };
  readonly 'tooling.promoteArtifact': { params: ToolingPromoteArtifactParams; result: ToolingPromoteArtifactResult };
  readonly 'tooling.sweepToolCache': { params: Record<string, never>; result: ToolingSweepToolCacheResult };
  readonly 'tooling.officeValidationCapabilities': { params: { readonly refresh?: boolean }; result: ToolingOfficeValidationCapabilitiesResult };
  readonly 'tooling.validateOfficeArtifacts': { params: ToolingValidateOfficeArtifactsParams; result: ToolingValidateOfficeArtifactsResult };
  readonly 'tooling.viewportStart': { params: { readonly cdpPort?: number }; result: ViewportStartResult };
  readonly 'tooling.viewportNavigate': { params: { readonly url: string }; result: ViewportNavigateResult };
  readonly 'tooling.viewportInput': { params: ViewportInputParams; result: ViewportInputResult };
  readonly 'tooling.viewportStop': { params: undefined; result: ViewportStopResult };
}

export type ServiceMethodName = keyof ServiceMethodMap;
