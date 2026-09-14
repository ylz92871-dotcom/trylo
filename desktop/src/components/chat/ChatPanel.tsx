// Trylo Desktop — ChatPanel. See spike-results/phase-2-ui-redesign.md §5.
//
// v1.5: the panel shows either the Code surface
// (MessageList + InputBar) or the Work surface
// (WorkPanel). Empty state is the brand mark + prompt.
//
// v1.15: the ProcessHeader was moved from the top of
// the chat panel into InputBar (per v1.15-handoff §1.1).
// The header is now the 24px status line directly above
// the input pill. ChatPanel still owns the run-state
// props (messages, running, error) — they just get
// forwarded to InputBar.
//
// v1.16.5+ (M3, W-UI-003): Code and Work are two
// CAPABILITIES feeding the same AgentConversationSurface.
// This file only decides which capability's data/actions
// fill the surface — no second timeline, composer, or
// scroll container exists anywhere. Work's capability
// contributions: the API-key banner (banner slot), the
// Diagnostics toggle/drawer (corner slot), the Artifact
// Dock (dock slot). Everything else — empty state,
// message timeline, run progress, composer — is shared.

import { useMemo, type ReactElement, type ReactNode } from 'react';
import type { FilePath } from '../../host-adapter/types';
import type { TryloHandlerContext } from '../../host-adapter/trylo-message-types';
import type { TryloSession } from '../../host-adapter/trylo-api';
import type { CodeMode, TopLevelMode } from '../../host-adapter/types';
import { latestContextTokens, type ChatMessage } from './types';
import type { Attachment, FailedAttachment } from '../../host-adapter/attachment-utils';
import {
  workAttachmentToView,
  type WorkAttachmentEntry,
} from '../../attachments/attachment-acquisition';
import { AgentConversationSurface } from './AgentConversationSurface';
import { EmptyState, WorkLanding } from './EmptyState';
import { InputBar } from './InputBar';
import type { ModelChoice } from './ModelSelector';
import type { LearningStatusChipProps } from '../user-learning/LearningStatusChip';
import type { LearningDirective } from '../../user-learning/types';

// M4-D: Work's capability-neutral empty state. Replaces
// the v1.16.5 reuse of Code's EmptyState plus the
// Office-oriented hint copy. Work now offers four
// goal-based starters; doc / sheet / deck / page are
// deliverable SHAPES a user can mention in the body,
// not the only modes of Work.
// v1.16.5+ (spec §5.3): the shared visible run state is
// derived ONCE here (the capability layer) and handed to
// the surface + composer — components don't guess.
import {
  type ConversationRunViewState,
  deriveConversationRunViewState,
} from './view-state';
// Work capability widget: the missing-API-key banner. 2026-09-04 (CLI 单核):
// the WorkDiagnostics drawer retired with the workd daemon.
import { ApiKeyMissingBanner } from '@trylo/work';

export interface ChatPanelProps {
  /** 2026-09-03 (run controls §UI-B): number of messages queued behind the
   *  current Code run, and a way to interrupt (steer) the oldest one. */
  readonly queuedCount?: number;
  readonly onInterruptQueued?: () => void;
  readonly workspaceRoot: FilePath;
  readonly context: TryloHandlerContext;
  readonly activeSession: TryloSession | null;
  readonly topMode: TopLevelMode;
  readonly codeMode: CodeMode;
  readonly onCodeModeChange: (mode: CodeMode) => void;
  // v1.16.1: plan → agent transition. App.tsx swaps
  // codeMode to 'agent' and clears the input so the
  // user can type "implement it" or similar.
  readonly onApplyPlan: () => void;
  readonly messages: readonly ChatMessage[];
  readonly onSend: (text: string) => void;
  readonly text: string;
  readonly onTextChange: (text: string) => void;
  // v1.16.5: the Work surface's primary "Open" artifact
  // action. Falls back to the host adapter inside
  // ArtifactCard when the in-app viewer doesn't apply.
  readonly onOpenWorkArtifact?: (path: string) => void;
  /** Code final-answer file mentions use the same right-side preview as the
   * result dock's Open action. Paths are workspace-relative. */
  readonly onOpenCodeArtifact?: (path: string) => void;
  // M3 closure §9.3 (M3-P1-11): the project-root-bound
  // host adapter for artifact open / show / copy actions.
  // App creates it per workspace root so every action is
  // containment-checked before reaching the host.
  readonly artifactHost: import('@trylo/work').HostAdapter;
  // v1.16.5: Phase 2.5 收口 — Work mode reuses the same
  // surface as Code. Inline artifact entries live inside
  // `workMessages` (kind: 'artifact').
  readonly workMessages: readonly ChatMessage[];
  /** P2-1 (spec §9): the Work capability's shared ResultDock, built by the
   *  host from the scoped result snapshot and rendered in the shared
   *  `resultDockSlot`. Replaces the old ArtifactDock. */
  readonly workResultDock?: ReactNode;
  /** P2-1 (spec §9): the Code capability's ResultDock, built by the host
   *  and rendered in the shared `resultDockSlot`. Optional — absent before
   *  the first run has a result. */
  readonly codeResultDock?: ReactNode;
  /**
   * Person | Team surface (spec §5.1): the quiet status row shown
   * just above the composer when a TeamRun is active on the current
   * Person (Code/Work) conversation. The host (App.tsx) wires it from
   * the team store. The slot is only rendered when the host passes
   * a node — empty / undefined hides it without a layout shift.
   */
  readonly personTeamStatusBar?: ReactNode;
  readonly workInput: string;
  readonly onWorkInputChange: (text: string) => void;
  readonly onWorkSend: (text: string) => void;
  /**
   * 2026-08-28 (Work chat-mode split): the explicit 任务
   * send under the composer — re-sends the composer text as
   * a WORK ORDER (tools + deliverables allowed) instead of
   * the default conversation send.
   */
  readonly onWorkRunAsTask?: (text: string) => void;
  /**
   * M4-D: Work empty-state starter pick. The host
   * writes the seed into the Work input; the user still
   * reviews and sends. Capability-neutral seeds only.
   */
  readonly onPickWorkStarter?: (seed: string, starterId: string) => void;
  /** M4-B: bound to `WorkRuntime.cancelTask` for the
   *  active task; rendered by the Work composer's
   *  ProcessHeader while a run is active. */
  readonly onWorkStop?: () => void;
  /** TRYLO-DUAL-SURFACE-SPEC §3.4: Work fifth-mode entry ("聊聊你怎么做
   *  报告"), forwarded to the Work InputBar. */
  readonly onWorkOpenCognition?: () => void;
  /** §3.4: disables the Work Cognition entry when User Cognition is off. */
  readonly workCognitionEnabled?: boolean;
  readonly workRunning: boolean;
  /** When true the composer lock / Stop control should engage.
   *  Excludes CONVERSATION runs (chat) so a plain chat can't
   *  disable the 任务 pill — W-RUN handoff §3.2. Falls back to
   *  `workRunning` when absent (back-compat). */
  readonly workComposerRunning?: boolean;
  readonly workCanSend: boolean;
  readonly workError?: boolean;
  /** P2 (spec §3.2): the effective UI permission level for THIS
   *  conversation. The parent (App.tsx) resolves it from the
   *  settings default + per-conversation override and snapshots
   *  it onto each turn. The panel only forwards; it never
   *  re-derives. */
  readonly permissionLevel: import('../../permission/permission-policy').PermissionLevel;
  readonly permissionSource: 'settings' | 'conversation';
  readonly permissionPendingNextTurn?: boolean;
  readonly onPermissionLevelChange: (level: import('../../permission/permission-policy').PermissionLevel) => void;
  /**
   * M4-E (spec §6.7 Core "approval"): the inline ApprovalCard responder,
   * wired to the supervisor's CodePermissionRegistry by the host.
   * 2026-09-04 (CLI 单核): the workd input-request responder retired with
   * the daemon.
   */
  readonly onRespondApproval?: (approvalId: string, approved: boolean) => void;
  // P3 (spec §3.3): open the right-side diff panel for a
  // pending approval's proposed change. The id is the
  // stable `approvalId` (Work) or `requestId` (Code).
  readonly onOpenApprovalPreview?: (id: string) => void;
  readonly onCognitionAnswer?: (id: string, text: string) => void;
  readonly onCognitionDismiss?: (id: string, kind: 'dismiss' | 'not_now' | 'snooze' | 'dont_ask_similar') => void;
  readonly onLearningImpactResolve?: (id: string, acceptPersonalization: boolean) => void;
  /** §4.2: in-task Cognition corner badge (rendered above the composer on the
   *  active surface; host decides which conversation it belongs to). */
  readonly cognitionBadgeSlot?: ReactNode;
  /** UL2-06: auditable learning receipt above the active composer. */
  readonly learningReceiptSlot?: ReactNode;
  readonly learning?: LearningStatusChipProps;
  readonly learningDirective?: LearningDirective;
  readonly onLearningDirectiveChange?: (value: LearningDirective | undefined) => void;
  /** 2026-08-28: task-suggestion chip accept (Work only).
   *  2026-08-29 fix: id for dismiss without duplicate bubble. */
  readonly onRunTaskSuggestion?: (text: string, id: string) => void;
  /** PR-3 遗留收口 (§6.5/§7.3): promote a conversation runtime artifact
   *  into `.trylo/out`. Work-only — the host binds the visible Work
   *  conversation's projectRoot + conversationId; the card only proposes
   *  the pinned file name from its own result text. */
  readonly onPromoteRuntimeArtifact?: (
    packageId: string,
    fileName: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  // v1.16.5: banner asking the user to configure the API
  // key when none is set; its button opens Settings.
  readonly hasApiKey?: boolean;
  readonly onOpenSettings?: () => void;
  /** True when the agent is currently running. v1.10. */
  readonly running?: boolean;
  /** True when the agent is in an error state. v1.15. */
  readonly error?: boolean;
  readonly onStop?: () => void;
  readonly sendingDisabled?: boolean;
  readonly contextUsed: number;
  readonly contextWindow: number;
  readonly model: string;
  /** Requested Tool Profile id for the Work composer chip (which MCP
   *  servers this run sees). App derives it from settings. Absent ⇒
   *  the Work composer shows no chip. Spreads into WorkSurface. */
  readonly toolProfileId?: string | null;
  /** v-modelsel: model picker chip (Code + Work action rows). */
  readonly configuredModel?: string;
  readonly poolModel?: string;
  readonly savedProfiles?: readonly ModelChoice[];
  readonly activeProfileId?: string;
  readonly onSelectConfigured?: () => void;
  readonly onSelectPool?: (model: string) => void;
  readonly onSelectProfile?: (id: string) => void;
  readonly onCompact: () => void;
  readonly compacting: boolean;
  readonly activeProcessId: string | null;
  readonly attachments: readonly Attachment[];
  readonly onAddAttachment: () => void;
  readonly onRemoveAttachment: (id: string) => void;
  readonly attachmentLoading: number;
  readonly failed: readonly FailedAttachment[];
  readonly onDismissFailed: (id: string) => void;
  /** P2-1 Work Package B: retry a retryable Code failure. */
  readonly onRetryFailed?: (id: string) => void;
  // P2-1 Work Package B: the Work surface's attachment strip. Same
  // shared InputBar + AttachmentList as Code — entries are staged
  // store records, mapped to the chip view shape here.
  readonly workAttachments: readonly WorkAttachmentEntry[];
  readonly onAddWorkAttachment: () => void;
  readonly onRemoveWorkAttachment: (id: string) => void;
  readonly workAttachmentLoading: number;
  readonly workFailed: readonly FailedAttachment[];
  readonly onDismissWorkFailed: (id: string) => void;
  readonly onRetryWorkFailed?: (id: string) => void;
  readonly isDragging: boolean;
  readonly editingMessageId: string | null;
  readonly onEditMessage: (id: string) => void;
  readonly onSaveEdit: (text: string) => void;
  readonly onCancelEdit: () => void;
}

export function ChatPanel(props: ChatPanelProps): ReactElement {
  // v1.16.5+ (spec §5.3): derive the Code run's visible
  // state once; the surface and composer both consume it.
  // Declared BEFORE the work-mode early return so the
  // hook order is stable across renders (Rules of Hooks).
  // When topMode is 'work' the value is unused; the Work
  // surface derives its own viewState in WorkSurface.
  const running = props.running ?? false;
  const error = props.error ?? false;
  const codeViewState = useMemo<ConversationRunViewState>(
    () =>
      deriveConversationRunViewState({
        messages: props.messages,
        running,
        error,
      }),
    [props.messages, running, error],
  );

  if (props.topMode === 'work') {
    return <WorkSurface {...props} />;
  }
  return (
    <AgentConversationSurface
      surface="code"
      messages={props.messages}
      running={running}
      viewState={codeViewState}
      emptyState={
        <EmptyState
          codeMode={props.codeMode}
          onSuggestion={props.onSend}
        />
      }
      composer={
        <InputBar
          codeMode={props.codeMode}
          onCodeModeChange={props.onCodeModeChange}
          onSend={props.onSend}
          text={props.text}
          onTextChange={props.onTextChange}
          messages={props.messages}
          running={running}
          error={error}
          workspace={props.workspaceRoot}
          viewState={codeViewState}
          canSend={!(props.sendingDisabled ?? false) || (running && props.activeProcessId !== null)}
          onStop={props.onStop}
          queuedCount={props.queuedCount}
          onInterruptQueued={props.onInterruptQueued}
          contextUsed={props.contextUsed}
          contextWindow={props.contextWindow}
          model={props.model}
          onCompact={props.onCompact}
          compacting={props.compacting}
          activeProcessId={props.activeProcessId}
          attachments={props.attachments}
          {...(props.onSelectPool
            ? {
                configuredModel: props.configuredModel ?? '',
                poolModel: props.poolModel ?? '',
                savedProfiles: props.savedProfiles,
                activeProfileId: props.activeProfileId ?? '',
                onSelectConfigured: props.onSelectConfigured ?? (() => undefined),
                onSelectPool: props.onSelectPool,
                onSelectProfile: props.onSelectProfile,
              }
            : {})}
          onAddAttachment={props.onAddAttachment}
          onRemoveAttachment={props.onRemoveAttachment}
          attachmentLoading={props.attachmentLoading}
          failed={props.failed}
          onDismissFailed={props.onDismissFailed}
          {...(props.onRetryFailed ? { onRetryFailed: props.onRetryFailed } : {})}
          isDragging={props.isDragging}
          // P2: forward the resolved permission level + change
          // handler. The picker is the same component on both
          // surfaces; ChatPanel does not branch on conversation
          // kind here — the value already reflects Code vs Work.
          permissionLevel={props.permissionLevel}
          permissionSource={props.permissionSource}
          {...(props.permissionPendingNextTurn !== undefined
            ? { permissionPendingNextTurn: props.permissionPendingNextTurn }
            : {})}
          onPermissionLevelChange={props.onPermissionLevelChange}
          {...(props.learning ? { learning: props.learning } : {})}
          {...(props.learningDirective ? { learningDirective: props.learningDirective } : {})}
          {...(props.onLearningDirectiveChange ? { onLearningDirectiveChange: props.onLearningDirectiveChange } : {})}
        />
      }
      editingMessageId={props.editingMessageId}
      onEditMessage={props.onEditMessage}
      onSaveEdit={props.onSaveEdit}
      onCancelEdit={props.onCancelEdit}
      workspacePath={props.workspaceRoot}
      onOpenArtifact={props.onOpenCodeArtifact}
      resultDockSlot={props.codeResultDock}
      personTeamStatusBarSlot={props.personTeamStatusBar}
      cognitionBadgeSlot={props.cognitionBadgeSlot}
      learningReceiptSlot={props.learningReceiptSlot}
      onCognitionAnswer={props.onCognitionAnswer}
      onCognitionDismiss={props.onCognitionDismiss}
      onLearningImpactResolve={props.onLearningImpactResolve}
    />
  );
}

/**
 * Work capability. Provides Work-specific data/actions to
 * the shared surface: banner, Diagnostics, Artifact Dock,
 * and a composer that hides Code-only controls
 * (compact / context ring actions). P2-1 Work Package B:
 * attachments are NO LONGER Code-only — Work forwards its
 * staged partition to the same InputBar + AttachmentList.
 */
function WorkSurface(props: ChatPanelProps): ReactElement {
  // P2-1 (spec §9): the ResultDock body is built entirely by the host from the
  // scoped result snapshot; the surface only places it in the shared slot.
  // v1.16.5+ (spec §5.3): derive the Work run's visible state once and feed
  // it to the surface + composer. 2026-09-04 (CLI 单核): the workd connection
  // / task-status inputs are gone — the CLI supervisor drives everything.
  const workViewState = useMemo<ConversationRunViewState>(
    () =>
      deriveConversationRunViewState({
        messages: props.workMessages,
        running: props.workRunning,
        error: props.workError,
      }),
    [props.workMessages, props.workRunning, props.workError],
  );
  // P2-1 Work Package B: staged entries → shared chip view shape.
  // Memoized on the snapshot array (reference-stable per partition
  // change) so the mapping never triggers re-render churn.
  const workAttachmentViews = useMemo(
    () => props.workAttachments.map(workAttachmentToView),
    [props.workAttachments],
  );
  // 2026-09-04: Work's own context-ring data. Same derivation as App's
  // Code-side `currentContextTokens` (latest turn_end usage), but read
  // from the WORK message stream so the ring reflects THIS surface's
  // run — the retired workd context-snapshot is not coming back.
  // Uses the shared `latestContextTokens` so a Work compaction also
  // drops the ring immediately (turn usage OR compaction tokensAfter).
  const workContextUsed = useMemo<number>(
    () => latestContextTokens(props.workMessages),
    [props.workMessages],
  );
  return (
    <AgentConversationSurface
      surface="work"
      messages={props.workMessages}
      running={props.workRunning}
      viewState={workViewState}
      emptyState={
        <WorkLanding
          hasApiKey={props.hasApiKey}
          onPickStarter={
            props.onPickWorkStarter ?? (() => undefined)
          }
        />
      }
      bannerSlot={
        props.hasApiKey === false
          ? <ApiKeyMissingBanner onOpenSettings={props.onOpenSettings} />
          : undefined
      }
      resultDockSlot={props.workResultDock}
      personTeamStatusBarSlot={props.personTeamStatusBar}
      cognitionBadgeSlot={props.cognitionBadgeSlot}
      learningReceiptSlot={props.learningReceiptSlot}
      composer={
        <InputBar
          conversationKind="work"
          codeMode="agent"
          onCodeModeChange={() => undefined}
          text={props.workInput}
          onTextChange={props.onWorkInputChange}
          onSend={props.onWorkSend}
          {...(props.onWorkRunAsTask
            ? { onRunAsTask: props.onWorkRunAsTask }
            : {})}
          {...(props.onWorkOpenCognition
            ? { onOpenCognition: props.onWorkOpenCognition, cognitionEnabled: props.workCognitionEnabled }
            : {})}
          canSend={props.workCanSend}
          onStop={props.onWorkStop}
          queuedCount={props.queuedCount}
          onInterruptQueued={props.onInterruptQueued}
          messages={props.workMessages}
          running={props.workRunning}
          error={props.workError}
          workspace={props.workspaceRoot}
          viewState={workViewState}
          // 2026-09-04 (CLI 单核): the workd workStatus / connection-status
          // / context-snapshot props are retired with the daemon — the CLI
          // supervisor view state drives the status line.
          // P2: same controlled props on the Work composer.
          permissionLevel={props.permissionLevel}
          permissionSource={props.permissionSource}
          {...(props.permissionPendingNextTurn !== undefined
            ? { permissionPendingNextTurn: props.permissionPendingNextTurn }
            : {})}
          onPermissionLevelChange={props.onPermissionLevelChange}
          // Code-only controls stay inert in Work mode.
          contextUsed={workContextUsed}
          contextWindow={props.contextWindow}
          model={props.model}
          compacting={false}
          onCompact={() => undefined}
          activeProcessId={null}
          // Tool-profile chip: which MCP servers THIS Work run sees.
          toolProfileId={props.toolProfileId}
          onOpenToolSettings={props.onOpenSettings}
          {...(props.onSelectPool
            ? {
                configuredModel: props.configuredModel ?? '',
                poolModel: props.poolModel ?? '',
                savedProfiles: props.savedProfiles,
                activeProfileId: props.activeProfileId ?? '',
                onSelectConfigured: props.onSelectConfigured ?? (() => undefined),
                onSelectPool: props.onSelectPool,
                onSelectProfile: props.onSelectProfile,
              }
            : {})}
          // P2-1 Work Package B: Work's attachment strip — the same
          // shared button + chips as Code, fed by the staged partition.
          attachments={workAttachmentViews}
          onAddAttachment={props.onAddWorkAttachment}
          onRemoveAttachment={props.onRemoveWorkAttachment}
          attachmentLoading={props.workAttachmentLoading}
          failed={props.workFailed}
          onDismissFailed={props.onDismissWorkFailed}
          {...(props.onRetryWorkFailed ? { onRetryFailed: props.onRetryWorkFailed } : {})}
          isDragging={props.isDragging}
          {...(props.learning ? { learning: props.learning } : {})}
          {...(props.learningDirective ? { learningDirective: props.learningDirective } : {})}
          {...(props.onLearningDirectiveChange ? { onLearningDirectiveChange: props.onLearningDirectiveChange } : {})}
        />
      }
      artifactHost={props.artifactHost}
      onOpenArtifact={props.onOpenWorkArtifact}
      workspacePath={props.workspaceRoot}
      onRespondApproval={props.onRespondApproval}
      onOpenApprovalPreview={props.onOpenApprovalPreview}
      {...(props.onRunTaskSuggestion
        ? { onRunTaskSuggestion: props.onRunTaskSuggestion }
        : {})}
      {...(props.onPromoteRuntimeArtifact
        ? { onPromoteRuntimeArtifact: props.onPromoteRuntimeArtifact }
        : {})}
      onCognitionAnswer={props.onCognitionAnswer}
      onCognitionDismiss={props.onCognitionDismiss}
      onLearningImpactResolve={props.onLearningImpactResolve}
    />
  );
}

/**
 * v1.16.5: Phase 2.5 收口 — Work mode's empty state. Shown
 * when there are no messages yet. It now shares the unified
 * LandingSurface with Code (see ./EmptyState → WorkLanding),
 * so the helper is inlined above in the work branch.
 */
