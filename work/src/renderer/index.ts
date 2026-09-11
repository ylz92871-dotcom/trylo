// Trylo Work — public renderer exports. See README.md.
//
// The host shell (Trylo Desktop) imports from this index. Anything
// not re-exported here is internal to the Work sub-app and the
// host shouldn't depend on it.

export { ArtifactCard } from "./ArtifactCard";
export type { ArtifactCardProps } from "./ArtifactCard";

// v1.16.5+ (M3, W-UI-003): the WorkPanel page shell is
// gone. The Work capability now ships two slot widgets
// the shared AgentConversationSurface composes: the
// Diagnostics toggle/drawer and the API-key banner.
export { WorkDiagnostics, ApiKeyMissingBanner } from "./WorkDiagnostics";
export type { WorkDiagnosticsProps } from "./WorkDiagnostics";

export {
  detectArtifactKind,
  getArtifactFormatLabel,
  canOpenArtifactInApp,
  isWordDocumentArtifactFile,
  isPresentationArtifactFile,
  isSpreadsheetArtifactFile,
  isWebPageArtifactFile,
  getFileName,
  getFileExtension,
} from "./format-helpers";
export type { ArtifactKind, Artifact } from "./format-helpers";

export type { HostAdapter, OpenWithApp } from "../host-adapter/host-adapter";
export { noOpHostAdapter } from "../host-adapter/host-adapter";

// Control Plane client (Phase 2.5). Lets the renderer talk
// to the coworkd daemon over WebSocket. Pure TS, no React,
// no Tauri — so the same client can be reused from Node tests
// or other shells.
export { createControlPlaneClient } from "../control-plane/client";
export type {
  ControlPlaneClient,
  ControlPlaneConfig,
  ClientStatus,
  EventFrame,
  RequestFrame,
  ResponseFrame,
  Frame,
} from "../control-plane/types";
export { Events, Methods, FrameType } from "../control-plane/types";

// v1.16.5+ (Step 1, W-RUN-001 完整收口): stable
// Work Runtime error event normalization. The Desktop UI
// consumes `normalizeError(frame)` to render failure
// notices; the upstream `task.event` payload shape MUST
// NOT leak past this boundary.
export { normalizeError, isErrorEvent } from "../event-normalizer.js";
export type {
  NormalizedError,
  NormalizedErrorCode,
} from "../event-normalizer.js";

// v1.16.5+ (Phase B, M1 lifecycle milestone): the
// WorkRuntimePort the Desktop UI consumes. The renderer
// does not call `client.send("task.create", ...)` or
// parse raw frames directly — it uses this adapter and
// subscribes to the registry + router decisions.
export { WorkRuntime } from "../work-runtime.js";
export type {
  WorkTauriInvoke,
  WorkEnv,
  WorkSpawnResult,
  WorkRuntimeOptions,
  WorkRuntimeEvents,
  WorkProjectionScope,
} from "../work-runtime.js";

// M4-C2: the Work context adapter + snapshot. The Desktop
// ContextRing consumes `runtime.context.snapshot(taskId)`; it never
// reads Control Plane payloads.
export { WorkContextAdapter } from "../work-context-adapter.js";
export { extractWorkContextEvent, emptyWorkContextSnapshot, workContextWindowFor } from "../work-context-adapter.js";
export type {
  ContextSnapshot,
  ContextCompaction,
  ContextSource,
  CompactionState,
  WorkContextEvent,
} from "../work-context-adapter.js";

export { TaskRegistry, isTerminal, extractTaskIdFromFrame } from "../task-registry.js";
export type { TaskRecord, TaskStatus, TaskChangeKind, TaskChangeListener } from "../task-registry.js";

export { TaskReconciler, mapDaemonStatus } from "../task-reconciler.js";
export type { ReconcilerOptions } from "../task-reconciler.js";

export { routeTaskEvent } from "../event-router.js";
export type { RouterDecision } from "../event-router.js";

export { presentTaskEvent } from "../event-presenter.js";
export type {
  ConversationItem,
  ConversationItemBody,
  WorkRunIdentity,
  InputRequestQuestion,
  InputRequestAnswer,
} from "../event-presenter.js";

// v1.16.5+ (M3 closure, spec §3): the single frame
// consumption entry point. The host calls
// `runtime.consumeFrame(frame)` and consumes the
// RuntimeUpdate; it never reads frame payloads.
export { consumeFrame, FrameDedupe } from "../consume-frame.js";
export type {
  RuntimeUpdate,
  FrameDropReason,
  DaemonEventLine,
  DiagnosticRouteDecision,
  DiagnosticSeverity,
  ConsumeFrameDeps,
} from "../consume-frame.js";

export { runIdForTask } from "../task-registry.js";

// v1.16.5+ (Work end-to-end workflow redesign spec §2.3): the
// turn intent contract. The Desktop snapshots it at send time and
// persists it on the session so refresh recovery never rediscovers
// intent from "did a tool event appear".
export { intentFromIsChat } from "../work-domain.js";
export type { WorkTurnIntent } from "../work-domain.js";

// 2026-08-29 (redesign spec §3 / §11.3): the pure turn
// projection contract. The Desktop mapper folds ConversationItems
// into a WorkTurnProjection and the linear UI renders from the
// projection alone — never from raw frames.
export type {
  WorkTurnProjection,
  WorkTurnState,
  WorkSemanticPhase,
  WorkPhaseState,
  WorkPhaseStatus,
  WorkActivity,
  WorkActivityKind,
  WorkActivityStatus,
  WorkBlocker,
  WorkEvidence,
  WorkTerminalPresentation,
  WorkNarrationMessage,
  WorkRunIdentity as WorkTurnRunIdentity,
} from "../work-domain.js";
export { WORK_SEMANTIC_PHASES, WORK_PHASE_LABELS } from "../work-domain.js";

export {
  createWorkTurnProjection,
  reduceWorkItem,
  reduceTaskStatus,
  deriveTurnState,
  derivePhaseNarration,
  shouldRenderPhaseRail,
} from "../work-workflow-reducer.js";
export type { ReduceOptions } from "../work-workflow-reducer.js";

// 2026-08-29 (redesign spec §10.2 / §10.3): terminal answer
// resolution with the deterministic fallback (the forbidden
// placeholder text is gone).
export {
  buildDeterministicFallback,
  isMissingFinalAnswer,
  resolveFinalAnswerText,
} from "../work-result-resolver.js";

// 2026-08-29 (redesign spec §8): the deliverable workflow pilot.
// Registry (one generic axis for every family), the presentation
// projection reducer, and the compatibility adapter that derives
// typed events from the EXISTING daemon surface.
export type {
  WorkDeliverableKind,
  WorkDeliverableProjection,
  DeliverableWorkflowDefinition,
  DeliverableMilestoneDefinition,
  DeliverableCheckpointDefinition,
  DeliverableValidatorDefinition,
  DeliverablePreviewStrategy,
  DeliverableWorkflowEvent,
  DeliverableFactBody,
  DeliverableValidationEntry,
  DeliverableValidationStatus,
  PresentationWorkflowProjection,
  PresentationBrief,
  PresentationBriefStatus,
  PresentationSource,
  PresentationSourceStatus,
  PresentationOutline,
  PresentationOutlineStatus,
  PresentationOutlineSlide,
  PresentationVisualDirection,
  PresentationVisualMode,
  PresentationImagePolicy,
  PresentationSlideUnit,
  PresentationSlideStatus,
  PresentationExport,
} from "../deliverables/deliverable-domain.js";
export {
  getDeliverableDefinition,
  detectDeliverableKindFromTool,
  detectDeliverableKindFromPath,
  detectDeliverableKindFromText,
} from "../deliverables/deliverable-registry.js";
export {
  createPresentationProjection,
  reduceDeliverableEvent,
  countSlidesAtLeast,
  realSlideCount,
  hasRealPageProgress,
} from "../deliverables/presentation-workflow.js";
export {
  applyDeliverableItem,
  deliverableEventsFromItem,
  deliverableIdForRun,
  deliverableMessageId,
} from "../deliverables/deliverable-workflow-adapter.js";
// WP-5 (spec §8.5 G): PPTX structure validation — the host
// supplies file facts; the evaluator stays pure + honest.
export {
  PPTX_VALIDATOR_IDS,
  evaluatePptxStructure,
  resourcesPending,
  visualQaNotRun,
  withPptxStructureFacts,
} from "../deliverables/pptx-validation.js";
export type { PptxStructureFacts } from "../deliverables/pptx-validation.js";

// M4-E (spec §6.7): the Work capability registry. The empty
// state reads ONLY `defaultStarters()`; `not_exposed`
// capabilities never enter starters or user promises.
export {
  WORK_CAPABILITIES,
  capabilityById,
  defaultStarters,
  exposedCapabilities,
  isExposed,
  isStable,
  validateWorkCapabilityRegistry,
} from "../work-capability-registry.js";
export type { CapabilityState, WorkCapability } from "../work-capability-registry.js";

// M4-E (spec §6.6): the capability-neutral task prompt
// contract. App.tsx builds Work prompts through this so the
// request is never wrapped in "Generate a document".
// P2-1 Work Package B: `formatWorkMessage` is the shared
// attachment projection used by BOTH the initial task prompt
// and every follow-up `task.sendMessage`.
export {
  buildWorkChatMessage,
  buildWorkProfilePrompt,
  buildWorkTaskFollowUp,
  buildWorkspaceTaskPrompt,
  formatWorkMessage,
  looksLikeTaskIntent,
} from "../work-prompt.js";
export type { WorkAttachmentDescriptor } from "../work-prompt.js";

// v1.16.5+ (M3 closure, spec §9): unified artifact
// projection. Events AND the terminal scan upsert into
// one WorkArtifactStore; the Dock reads only that store.
// Path canonicalization (§9.2) lives in artifact-paths.
export { WorkArtifactStore } from "../work-artifact-store.js";
export type {
  ArtifactKind as WorkArtifactKindDomain,
} from "./format-helpers";
export type {
  WorkArtifactTarget,
  WorkArtifactChange,
  WorkArtifactSource,
  WorkArtifactKind,
  WorkFileSignature,
  WorkArtifactRecord,
  WorkRunDelta,
  WorkResult,
  WorkArtifactScope,
  ScannedArtifact,
  WorkScanResult,
  WorkProjectionStatus,
  WorkRunOutcome,
  WorkRunTerminalState,
} from "../work-artifact-store.js";
export {
  canonicalAbsolutePath,
  relativeArtifactPath,
  artifactDisplayName,
  isWindowsStylePath,
  validateArtifactTarget,
  isHttpArtifact,
  artifactDenialText,
} from "../artifact-paths.js";
export type {
  ArtifactOpenDenialReason,
  ArtifactOpenVerdict,
} from "../artifact-paths.js";
