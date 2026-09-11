// Trylo Desktop — InputBar.
//
// v1.7: the + indicator opens a ModePopover (Chat / Plan
// / Agent). The popover is a real listbox, keyboard
// navigable, dismissable on Escape / outside click.
//
// v1.15: a 24px status line is rendered ABOVE the input
// box (not inside it). The status line reuses ProcessHeader
// and shows the agent state (ready / running / error) plus
// the workspace root. See v1.15-handoff §1.1.
//
// v1.16.0: a 24px action row is rendered BELOW the input
// box. It hosts the ContextRing (tokens / window) on the
// left; the right side is reserved for upcoming items
// (attach, permission dropdown, model picker). The layout
// mirrors Codex's chat input — input → action row below.

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from 'react';
import type { CodeMode } from '../../host-adapter/types';
import type { ChatMessage } from './types';
import type { Attachment, FailedAttachment } from '../../host-adapter/attachment-utils';
import { ArrowUp } from 'lucide-react';
import { ModePopover } from './ModePopover';
import { ModelSelector } from './ModelSelector';
import { PermissionLevelPicker } from './PermissionLevelPicker';
import { ToolProfileChip } from './ToolProfileChip';
import { ProcessHeader } from './ProcessHeader';
import { LearningStatusChip, type LearningStatusChipProps } from '../user-learning/LearningStatusChip';
import { AttachmentList } from './AttachmentList';
import { ContextRing } from '../app-shell/ContextRing';
import { WorkTaskMenu } from '../work/WorkTaskMenu';
import type { ConversationRunViewState } from './view-state';
import type { PermissionLevel } from '../../permission/permission-policy';

const CODE_LABEL: Record<CodeMode, string> = {
  chat:      'Chat',
  plan:      'Plan',
  agent:     'Agent',
  cognition: 'Cognition',
};

const CODE_PLACEHOLDER: Record<CodeMode, string> = {
  chat:      'What are you building?',
  plan:      'What do you want to design first?',
  agent:     'Tell the agent what to do…',
  cognition: 'Tell Trylo how you like to work. This does not write code…',
};

const CODE_HINT: Record<CodeMode, string> = {
  chat:      'Ask anything',
  plan:      'Design first',
  agent:     'Build + test',
  cognition: 'Learn you',
};

export interface InputBarProps {
  /**
   * Code exposes the Chat / Plan / Agent selector. Work is a separate
   * conversation kind, so it gets a non-interactive marker instead of
   * inheriting Code-only controls.
   */
  readonly conversationKind?: 'code' | 'work';
  readonly codeMode: CodeMode;
  readonly onCodeModeChange: (mode: CodeMode) => void;
  readonly onSend: (text: string) => void;
  /**
   * 2026-08-28 (Work chat-mode split): the explicit 任务
   * send. Rendered under the composer (Work only) as the
   * one VISIBLE work trigger — the default ⏎ send is a
   * conversation message. Same gating as `canSend`.
   */
  readonly onRunAsTask?: (text: string) => void;
  /** TRYLO-DUAL-SURFACE-SPEC §3.4: Work fifth-mode entry ("聊聊你怎么做
   *  报告"), rendered next to WorkTaskMenu. Absent ⇒ the Work bar is a pure
   *  Work sender with no Cognition entry. */
  readonly onOpenCognition?: () => void;
  /** §3.4: disables the Work Cognition entry when User Cognition is off. */
  readonly cognitionEnabled?: boolean;
  readonly text: string;
  readonly onTextChange: (text: string) => void;
  readonly canSend?: boolean;
  /** M4-B: Work stop → `WorkRuntime.cancelTask`. Rendered
   *  by the ProcessHeader while a Work run is active. */
  readonly onStop?: () => void;
  /** 2026-09-03 (run controls §UI-B): when a Code run is live and the user
   *  queued messages behind it, show a compact pill with the count and an
   *  explicit interrupt affordance (default is queue, interrupt is opt-in). */
  readonly queuedCount?: number;
  readonly onInterruptQueued?: () => void;
  /** Messages rendered above — used to derive run stats for the status line. */
  readonly messages: readonly ChatMessage[];
  /** True when the agent is currently running. */
  readonly running: boolean;
  /** True when the agent is in an error state. Wins over running. */
  readonly error?: boolean;
  /** Workspace root. Shown in the status line when idle. */
  readonly workspace?: string;
  /** P2 (spec §3.2): the effective UI permission level.
   *  The chip's controlled value is owned by the parent
   *  (App.tsx). The picker is a pure renderer; it never
   *  resolves effective level itself. */
  readonly permissionLevel: PermissionLevel;
  /** Where the effective level came from. The picker shows
   *  the source inside the menu footer so the user always
   *  knows whether the chip is following the global default
   *  or a per-conversation override. */
  readonly permissionSource: 'settings' | 'conversation';
  /** True when a run is in flight AND the next turn will use
   *  a different level. The chip shows "下轮生效" without
   *  changing the controlled value. */
  readonly permissionPendingNextTurn?: boolean;
  /** P2 (spec §3.2): user-picked level change. The parent
   *  decides whether to apply it now or queue for the next
   *  turn. */
  readonly onPermissionLevelChange: (level: PermissionLevel) => void;
  /**
   * v1.16.5+ (spec §5.3): the already-derived visible run
   * state, forwarded to the ProcessHeader so the header
   * does not re-derive it. Optional — the header falls
   * back to its own derivation when absent.
   */
  readonly viewState?: ConversationRunViewState;
  // v1.16.0: ring data. Sourced from App.tsx, which
  // derives `contextUsed` from the latest TurnMessage's
  // usage.input_tokens and `contextWindow` from the
  // active model (contextWindowFor).
  readonly contextUsed: number;
  readonly contextWindow: number;
  readonly model: string;
  /**
   * v-modelsel: model picker chip (Code + Work action rows).
   * `configuredModel` is the user's own model (settings.apiModel);
   * `poolModel` is the active built-in pool override
   * (settings.poolModel; '' = not on pool). The effective model for
   * a run is poolModel || configuredModel. The chip is only rendered
   * when `onSelectPool` is provided.
   */
  readonly configuredModel?: string;
  readonly poolModel?: string;
  readonly onSelectConfigured?: () => void;
  readonly onSelectPool?: (model: string) => void;
  // v1.16.0: when busy, the ring's popover shows
  // "Compacting…" and disables the action. Sourced
  // from App.tsx (last message is a pending "Compacting
  // context…" notice).
  readonly compacting: boolean;
  // v1.16.2: attachments. The chips render between
  // the input row and the action row; the 📎 button
  // sits to the LEFT of the + mode button and opens
  // the Tauri file picker (App.tsx wires the handler).
  // P2-1 Work Package B: BOTH surfaces render the same
  // button + strip — the capability comes from the host
  // props, not from a hardcoded surface check.
  readonly attachments: readonly Attachment[];
  readonly onAddAttachment: () => void;
  readonly onRemoveAttachment: (id: string) => void;
  // v1.16.2.6: 1.16.2.6: forwarded to AttachmentList so
  // it can render a "Reading N file(s)…" chip with a
  // spinner while the desktop is reading file bytes.
  readonly attachmentLoading?: number;
  // v1.16.2.6: visible error feedback. App.tsx records
  // each failed attachment (stat error, too big,
  // unreadable format) into this list. Rendered as red
  // error chips in AttachmentList. User can dismiss.
  readonly failed?: readonly FailedAttachment[];
  readonly onDismissFailed?: (id: string) => void;
  // P2-1 Work Package B: retry a retryable failure (Work
  // staging transient errors). Renders a ↻ on the failed
  // chip when the failure is retryable.
  readonly onRetryFailed?: (id: string) => void;
  // v1.16.3: Tauri drag-drop highlight. When true,
  // the input row shows a dashed overlay ("Drop files
  // to attach"). Driven by App.tsx's Tauri
  // onDragDropEvent handler.
  readonly isDragging?: boolean;
  // v1.16.2.1: manual compaction is now triggered by
  // clicking the ring itself (it opens a popover with
  // usage + a "Compact now" button). The action-row
  // CompactButton is gone — single point of interaction.
  readonly onCompact: () => void;
  /** Tool-profile chip (Work composer only). The requested profile id
   *  driving this run's MCP servers — App derives it from settings via
   *  workProfileIdFor. Absent ⇒ no chip (the Code surface mounts no
   *  trylo servers, so there is nothing to show). */
  readonly toolProfileId?: string | null;
  /** Opens Settings (the profile toggles live there). Absent ⇒ the
   *  chip popover is read-only. */
  readonly onOpenToolSettings?: () => void;
  // v1.16.2.2: forwarded so the ring can show a
  // "no live CLI" hint when the user clicks Compact
  // in a dev session with no Tauri spawn.
  readonly activeProcessId: string | null;
  /** User Learning status chip. Opens the inspector; Code and Work share it. */
  readonly learning?: LearningStatusChipProps;
}

export function InputBar(props: InputBarProps): ReactElement {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { text, onSend } = props;
  const isWork = props.conversationKind === 'work';

  const autoResize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    const max = 160; // 约 6-7 行，超过滚动
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    autoResize(textareaRef.current);
  }, [text, autoResize]);

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = text.trim();
      if (trimmed === '') return;
      onSend(trimmed);
    },
    [text, onSend],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const trimmed = text.trim();
        if (trimmed === '') return;
        onSend(trimmed);
      }
    },
    [text, onSend],
  );

  return (
    <div className="input-bar-wrapper">
      <ProcessHeader
        messages={props.messages}
        running={props.running}
        error={props.error}
        workspace={props.workspace}
        viewState={props.viewState}
        onStop={props.onStop}
      />
      <form
        className={
          'input-bar'
          + (isWork ? ' input-bar--work' : '')
          + (!isWork && props.codeMode === 'plan' ? ' input-bar--plan' : '')
          + (!isWork && props.codeMode === 'cognition' ? ' input-bar--cognition' : '')
          + (props.isDragging ? ' input-bar--dragging' : '')
        }
        onSubmit={onSubmit}
      >
        {isWork ? (
          <div className="input-bar__work-mode-group">
            <span className="input-bar__mode input-bar__mode--static" aria-label="Work conversation">
              <span className="input-bar__kind-mark" aria-hidden="true">W</span>
              <span className="input-bar__mode-label">Work</span>
            </span>
            {props.onRunAsTask && (
              <WorkTaskMenu onRunTask={props.onRunAsTask} />
            )}
            {props.onOpenCognition && (
              <button
                type="button"
                className="input-bar__cognition-entry"
                title="说说这次报告/交付希望我怎么把握"
                disabled={props.cognitionEnabled === false}
                onClick={() => props.onOpenCognition?.()}
              >
                聊聊你怎么做报告
              </button>
            )}
          </div>
        ) : (
          <button
            ref={plusRef}
            type="button"
            className="input-bar__mode"
            title="Code sub-mode"
            aria-label={`Code sub-mode: ${CODE_LABEL[props.codeMode]}`}
            aria-haspopup="listbox"
            aria-expanded={popoverOpen}
            onClick={() => setPopoverOpen((v) => !v)}
          >
            <span className="input-bar__mode-plus" aria-hidden="true">+</span>
            <span className="input-bar__mode-label">{CODE_LABEL[props.codeMode]}</span>
          </button>
        )}
        {!isWork && popoverOpen && (
          <ModePopover
            current={props.codeMode}
            onSelect={props.onCodeModeChange}
            onClose={() => setPopoverOpen(false)}
            anchorRef={plusRef}
          />
        )}
        {/* v1.16.2: attachment button. Sits between the
            mode picker and the input. Sibling of +,
            not child — keeps the file picker independent
            of the mode dropdown. P2-1 Work Package B:
            rendered on BOTH surfaces (Code + Work). */}
        <button
          type="button"
          className="input-bar__attach"
          onClick={props.onAddAttachment}
          title="Attach files (Office docs, images, text)"
          aria-label="Attach files"
        >
          <span aria-hidden="true">📎</span>
        </button>
        <textarea
          ref={textareaRef}
          className="input-bar__input"
          value={props.text}
          onChange={(e) => {
            props.onTextChange(e.target.value);
            autoResize(e.target);
          }}
          onKeyDown={onKeyDown}
          placeholder={props.viewState === 'awaiting_input'
            ? '直接回复，任务会从这里继续…'
            : props.running
              ? '输入调整方向，Enter 立即引导当前任务…'
              : isWork
                ? '在当前工作区研究、整理或生成产物…'
                : `${CODE_PLACEHOLDER[props.codeMode]}  ·  ${CODE_HINT[props.codeMode]}`}
          rows={1}
          spellCheck={false}
          autoComplete="off"
          aria-label="Message"
        />
        {/* 2026-09-03 (run controls §UI-B): queue hint while a run is live and
            messages are pended behind it. Default is queue; the inline
            interrupt affordance steers the oldest one immediately. */}
        {props.running && (props.queuedCount ?? 0) > 0 && (
          <span className="input-bar__queued" role="status">
            <span className="input-bar__queued-count">{props.queuedCount} 条已排队</span>
            {props.onInterruptQueued && (
              <button
                type="button"
                className="input-bar__queued-interrupt"
                onClick={props.onInterruptQueued}
                title="立即把这条消息插进当前任务（打断）"
              >
                立即打断
              </button>
            )}
          </span>
        )}
        {/* The send slot is ALWAYS the arrow; the single Stop control lives
            in the ProcessHeader above (dedupe, spec UI-de-dup). The arrow
            stays enabled whenever there is text, even while a run is active —
            that message either queues or interrupts (see App.onSend). */}
        <button
          type="submit"
          className="input-bar__send"
          disabled={props.canSend === false || props.text.trim() === ''}
          title={props.running ? '发送（可排队或打断）' : '发送'}
          aria-label={props.running ? '发送（可排队或打断）' : '发送'}
        >
          <ArrowUp size={16} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </form>
      {/* v1.16.2: attachment chips strip. Sits between
          the input row and the action row; null when
          the list is empty (no extra height). */}
      <AttachmentList
        attachments={props.attachments}
        onRemove={props.onRemoveAttachment}
        loading={props.attachmentLoading}
        failed={props.failed}
        onDismissFailed={props.onDismissFailed}
        {...(props.onRetryFailed ? { onRetryFailed: props.onRetryFailed } : {})}
      />
      {/* v1.16.0: bottom action row (Codex-style). The
          ContextRing sits on the right with the new
          onCompact prop — clicking the ring opens a
          popover with usage + a "Compact now" action.
          The left side is a flex spacer for future
          items (attach button could move here, etc.).
          Don't disturb the ring's right anchor.

          P2 (spec §3.2): the permission level chip lives
          on the LEFT of the action row on both Code and
          Work surfaces — same chip, same four levels, same
          keyboard model. The chat/plan/agent selector in
          the input row above is the interaction intent and
          stays decoupled from the permission chip. */}
      {isWork ? (
        <div className="input-bar__actions">
          <PermissionLevelPicker
            level={props.permissionLevel}
            source={props.permissionSource}
            {...(props.permissionPendingNextTurn !== undefined
              ? { pendingNextTurn: props.permissionPendingNextTurn }
              : {})}
            onChange={props.onPermissionLevelChange}
          />
          {/* Tool-profile chip: which MCP servers THIS run sees. Work
              only — the Code surface mounts no trylo servers. */}
          {props.toolProfileId ? (
            <ToolProfileChip
              profileId={props.toolProfileId}
              {...(props.onOpenToolSettings ? { onOpenToolSettings: props.onOpenToolSettings } : {})}
            />
          ) : null}
          {props.learning ? <LearningStatusChip {...props.learning} /> : null}
          <div className="input-bar__actions-spare" aria-hidden="true" />
          {props.onSelectPool ? (
            <ModelSelector
              configuredModel={props.configuredModel ?? ''}
              poolModel={props.poolModel ?? ''}
              onSelectConfigured={props.onSelectConfigured ?? (() => undefined)}
              onSelectPool={props.onSelectPool}
            />
          ) : null}
          {/* 2026-09-04: Work gets the same context ring as Code.
              Passive gauge (no onCompact) until a Work compaction
              entry is wired — clicking does nothing, no fake "✓ Sent". */}
          <ContextRing used={props.contextUsed} total={props.contextWindow} />
        </div>
      ) : (
        <div className="input-bar__actions">
          <PermissionLevelPicker
            level={props.permissionLevel}
            source={props.permissionSource}
            {...(props.permissionPendingNextTurn !== undefined
              ? { pendingNextTurn: props.permissionPendingNextTurn }
              : {})}
            onChange={props.onPermissionLevelChange}
          />
          {props.learning ? <LearningStatusChip {...props.learning} /> : null}
          <div className="input-bar__actions-spare" aria-hidden="true" />
          {props.onSelectPool ? (
            <ModelSelector
              configuredModel={props.configuredModel ?? ''}
              poolModel={props.poolModel ?? ''}
              onSelectConfigured={props.onSelectConfigured ?? (() => undefined)}
              onSelectPool={props.onSelectPool}
            />
          ) : null}
          <ContextRing
            used={props.contextUsed}
            total={props.contextWindow}
            onCompact={props.onCompact}
          />
        </div>
      )}
    </div>
  );
}
