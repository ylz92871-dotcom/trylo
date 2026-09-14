// Trylo Desktop — AgentConversationSurface.
//
// v1.16.5+ (M3, W-UI-003): the ONE conversation layout
// Code and Work share. Previously the Work branch of
// ChatPanel wrapped a second tree (WorkPanel shell +
// its own MessageList/InputBar composition), which gave
// Work a second page hierarchy. The surface now owns:
//
//   EmptyState | MessageTimeline (single scroll owner)
//   run progress (StreamingIndicator inside the list)
//   Thinking / Plan / Tool / Artifact / Error rows
//     (all ChatMessage kinds — rendered by Message)
//   Composer (bottom)
//   optional slots: banner / corner (Diagnostics) /
//     mode chip / Artifact Dock
//
// Code and Work are CAPABILITIES feeding this surface:
// they provide runtime/domain data and capability
// actions, never a second layout.

import type { ReactElement, ReactNode } from 'react';
import type { ChatMessage } from './types';
import { MessageList } from './MessageList';
import type { ConversationRunViewState } from './view-state';

export interface AgentConversationSurfaceProps {
  readonly surface: 'code' | 'work';
  readonly messages: readonly ChatMessage[];
  readonly running: boolean;
  /** v1.16.5+ (spec §5.3): the shared visible run state —
   *  the single driver of the timeline footer indicator.
   *  Computed once by the capability (ChatPanel). */
  readonly viewState?: ConversationRunViewState;
  /** Rendered instead of the timeline while the
   *  conversation is empty. */
  readonly emptyState: ReactNode;
  /** The composer (InputBar) fully configured by the
   *  capability. */
  readonly composer: ReactNode;
  /** Above the timeline — e.g. the Work API-key banner. */
  readonly bannerSlot?: ReactNode;
  /** Top-right overlay — e.g. the Work Diagnostics
   *  toggle/drawer. Must not take layout space. */
  readonly cornerSlot?: ReactNode;
  /** Between timeline and composer — Code's ModeChip. */
  readonly modeSlot?: ReactNode;
  /** P2-1 (spec §9): the shared ResultDock slot between the timeline and
   *  the composer. Both Code and Work feed the same shell through their
   *  mode-specific content. */
  readonly resultDockSlot?: ReactNode;
  /** P5 (spec §5.1): the Person surface keeps its existing layout; the
   *  status bar for an attached TeamRun sits BETWEEN ResultDock and the
   *  composer. Host-only — empty when no TeamRun is active. */
  readonly personTeamStatusBarSlot?: ReactNode;
  /** §4.2: the in-task Cognition corner badge. Rendered as the last in-flow
   *  element so its 0-height box sits directly above the composer; the pill
   *  floats bottom-right. Must NOT take layout space. */
  readonly cognitionBadgeSlot?: ReactNode;
  /** UL2-06: quiet, in-flow learning receipt rendered beside Cognition. */
  readonly learningReceiptSlot?: ReactNode;
  // Code inline-edit pass-through (inert for Work).
  readonly editingMessageId?: string | null;
  readonly onEditMessage?: (id: string) => void;
  readonly onSaveEdit?: (text: string) => void;
  readonly onCancelEdit?: () => void;
  // Work inline-artifact pass-through (inert for Code).
  readonly artifactHost?: import('@trylo/work').HostAdapter;
  readonly onOpenArtifact?: (path: string) => void;
  readonly workspacePath?: string;
  // M4-E (spec §6.7 Core "approval / input"): inline
  // decision responders (inert for Code).
  readonly onRespondApproval?: (approvalId: string, approved: boolean) => void;
  // P3 (spec §3.3): open the right-side diff panel for a
  // pending approval's proposed change. The id is the
  // stable `approvalId` (Work) or `requestId` (Code). The
  // card forwards it; the host wires the open to the panel.
  readonly onOpenApprovalPreview?: (id: string) => void;
  // 2026-08-28 (Work chat-mode split): task-suggestion chip
  // accept (inert for Code).
  // 2026-08-29 fix: id for dismiss without duplicate bubble.
  readonly onRunTaskSuggestion?: (text: string, id: string) => void;
  /** PR-3 遗留收口: ToolCard runtime-artifact promote affordance
   *  (Work-only; Code conversations never receive it). */
  readonly onPromoteRuntimeArtifact?: (
    packageId: string,
    fileName: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  readonly onCognitionAnswer?: (id: string, text: string) => void;
  readonly onCognitionDismiss?: (id: string, kind: 'dismiss' | 'not_now' | 'snooze' | 'dont_ask_similar') => void;
  readonly onLearningImpactResolve?: (id: string, acceptPersonalization: boolean) => void;
}

export function AgentConversationSurface(
  props: AgentConversationSurfaceProps,
): ReactElement {
  const isEmpty = props.messages.length === 0;
  return (
    <div className="chat-panel">
      {props.cornerSlot !== undefined && (
        <div className="chat-panel__corner">{props.cornerSlot}</div>
      )}
      {props.bannerSlot !== undefined && (
        <div className="chat-panel__banner">{props.bannerSlot}</div>
      )}
      {isEmpty ? (
        props.emptyState
      ) : (
        <MessageList
          surface={props.surface}
          messages={props.messages}
          running={props.running}
          viewState={props.viewState}
          editingMessageId={props.editingMessageId}
          onEditMessage={props.onEditMessage}
          onSaveEdit={props.onSaveEdit}
          onCancelEdit={props.onCancelEdit}
          artifactHost={props.artifactHost}
          onOpenArtifact={props.onOpenArtifact}
          workspacePath={props.workspacePath}
          onRespondApproval={props.onRespondApproval}
          onOpenApprovalPreview={props.onOpenApprovalPreview}
          onRunTaskSuggestion={props.onRunTaskSuggestion}
          onPromoteRuntimeArtifact={props.onPromoteRuntimeArtifact}
          onCognitionAnswer={props.onCognitionAnswer}
          onCognitionDismiss={props.onCognitionDismiss}
          onLearningImpactResolve={props.onLearningImpactResolve}
        />
      )}
      {props.modeSlot !== undefined && (
        <div className="chat-panel__mode">{props.modeSlot}</div>
      )}
      {props.resultDockSlot}
      {props.personTeamStatusBarSlot}
      {props.cognitionBadgeSlot}
      {props.learningReceiptSlot}
      {props.composer}
    </div>
  );
}
