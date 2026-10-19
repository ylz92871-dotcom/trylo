import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from 'react';
import type { CodeMode, TopLevelMode } from '../../host-adapter/types';
import type { ChatMessage } from './types';
import type { Attachment, FailedAttachment } from '../../host-adapter/attachment-utils';
import { ArrowUp, Plus, ChevronDown, Code2, BriefcaseBusiness, Folder, MoreHorizontal } from 'lucide-react';
import { ModePopover } from './ModePopover';
import { ModelSelector, type ModelChoice } from './ModelSelector';
import { PermissionLevelPicker } from './PermissionLevelPicker';
import { ToolProfileChip } from './ToolProfileChip';
import { ProcessHeader } from './ProcessHeader';
import { LearningStatusChip, type LearningStatusChipProps } from '../user-learning/LearningStatusChip';
import { LearningDirectiveMenu } from '../user-learning/LearningDirectiveMenu';
import type { LearningDirective } from '../../user-learning/types';
import { AttachmentList } from './AttachmentList';
import { ContextRing } from '../app-shell/ContextRing';
import type { ConversationRunViewState } from './view-state';
import type { PermissionLevel } from '../../permission/permission-policy';

const CODE_LABEL: Record<CodeMode, string> = { agent: '执行', chat: '对话', plan: '计划', cognition: '偏好' };
const CODE_PLACEHOLDER: Record<CodeMode, string> = {
  agent: '描述任务，或添加文件…', chat: '讨论代码，或描述你遇到的问题…',
  plan: '说说你想实现什么，我们先梳理方案…', cognition: '说说你希望 Trylo 怎样与你合作…',
};

export interface InputBarProps {
  /**
   * Code exposes the Chat / Plan / Agent selector. Work is a separate
   * conversation kind, so it gets a non-interactive marker instead of
   * inheriting Code-only controls.
   */
  readonly conversationKind?: 'code' | 'work';
  readonly onTopModeChange?: (mode: TopLevelMode) => void;
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
   *  报告"), rendered in the Work options disclosure. Absent ⇒ the Work bar is a pure
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
  readonly savedProfiles?: readonly ModelChoice[];
  readonly activeProfileId?: string;
  readonly onSelectConfigured?: () => void;
  readonly onSelectPool?: (model: string) => void;
  readonly onSelectProfile?: (id: string) => void;
  // v1.16.0: when busy, the ring's popover shows
  // "Compacting…" and disables the action. Sourced
  // from App.tsx (last message is a pending "Compacting
  // context…" notice).
  readonly compacting: boolean;
  readonly compactAvailable?: boolean;
  readonly contextUnknown?: boolean;
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
  /** One-shot behavior for the next accepted Code/Work send. */
  readonly learningDirective?: LearningDirective;
  readonly onLearningDirectiveChange?: (value: LearningDirective | undefined) => void;
}

export function InputBar(props: InputBarProps): ReactElement {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isWork = props.conversationKind === 'work';
  const canSend = props.canSend !== false && props.text.trim().length > 0;
  const resize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(62, Math.min(el.scrollHeight, 160))}px`;
    el.style.overflowY = el.scrollHeight > 160 ? 'auto' : 'hidden';
  }, []);
  useEffect(() => { resize(textareaRef.current); }, [props.text, resize]);
  const send = (): void => { if (canSend) props.onSend(props.text.trim()); };
  const submit = (event: FormEvent): void => { event.preventDefault(); send(); };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); send();
    }
  };
  const workspaceName = props.workspace?.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop();
  return <div className="input-bar-wrapper">
    <form className={`input-bar${isWork ? ' input-bar--work' : ''}${props.isDragging ? ' input-bar--dragging' : ''}`} onSubmit={submit}>
      <textarea ref={textareaRef} className="input-bar__input" value={props.text}
        onChange={(event) => props.onTextChange(event.target.value)} onKeyDown={keyDown}
        placeholder={props.viewState === 'awaiting_input' ? '直接回复，任务会从这里继续…'
          : props.running ? '输入调整方向，Enter 发送后续消息…'
          : isWork ? '描述你想完成的工作，或添加资料…' : CODE_PLACEHOLDER[props.codeMode]}
        rows={2} spellCheck={false} autoComplete="off" aria-label="Message" />
      <AttachmentList attachments={props.attachments} onRemove={props.onRemoveAttachment}
        loading={props.attachmentLoading} failed={props.failed} onDismissFailed={props.onDismissFailed} onRetryFailed={props.onRetryFailed} />
      <div className="input-bar__toolbar">
        <button type="button" className="input-bar__attach" onClick={props.onAddAttachment} title="添加文件或图片" aria-label="Attach files"><Plus size={18} /></button>
        <div className="input-bar__mode-anchor">
          <button ref={plusRef} type="button" className="input-bar__mode" aria-label={`任务类型: ${isWork ? 'Work' : 'Code'}`} aria-haspopup="menu" aria-expanded={popoverOpen} onClick={() => setPopoverOpen((open) => !open)}>
            {isWork ? <BriefcaseBusiness size={14} /> : <Code2 size={14} />}
            <span>{isWork ? 'Work' : 'Code'}{!isWork && props.codeMode !== 'agent' ? ` · ${CODE_LABEL[props.codeMode]}` : ''}</span><ChevronDown size={12} />
          </button>
          {popoverOpen && <ModePopover current={props.codeMode} kind={isWork ? 'work' : 'code'} onKindChange={props.onTopModeChange} onSelect={props.onCodeModeChange} onClose={() => setPopoverOpen(false)} anchorRef={plusRef} />}
        </div>
        {props.onSelectPool && <ModelSelector configuredModel={props.configuredModel ?? ''} poolModel={props.poolModel ?? ''}
          savedProfiles={props.savedProfiles} activeProfileId={props.activeProfileId ?? ''} onSelectConfigured={props.onSelectConfigured ?? (() => undefined)}
          onSelectPool={props.onSelectPool} onSelectProfile={props.onSelectProfile} />}
        <div className="input-bar__actions-spare" />
        {props.running && (props.queuedCount ?? 0) > 0 && <span className="input-bar__queued" role="status">
          {props.queuedCount} 条已排队{props.onInterruptQueued && <button type="button" onClick={props.onInterruptQueued}>立即打断</button>}
        </span>}
        <button type="submit" className="input-bar__send" disabled={!canSend} title={props.running ? '发送（可排队或打断）' : '发送'} aria-label={props.running ? '发送（可排队或打断）' : '发送'}><ArrowUp size={18} strokeWidth={2.2} /></button>
      </div>
    </form>
    <div className="input-bar__actions">
      <PermissionLevelPicker level={props.permissionLevel} source={props.permissionSource} pendingNextTurn={props.permissionPendingNextTurn} onChange={props.onPermissionLevelChange} />
      {workspaceName && <span className="input-bar__workspace" title={props.workspace}><Folder size={12} />{workspaceName}</span>}
      {isWork && props.toolProfileId && <ToolProfileChip profileId={props.toolProfileId} onOpenSettings={props.onOpenToolSettings} />}
      {(props.learning || props.onLearningDirectiveChange || (isWork && props.onOpenCognition)) && <button type="button" className="input-bar__more" title="学习与协作选项" aria-label="学习与协作选项" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}><MoreHorizontal size={16} /></button>}
      <div className="input-bar__actions-spare" />
      <span className="input-bar__hint">Enter 发送</span>
      {(props.contextUsed > 0 || props.contextUnknown) && <ContextRing used={props.contextUsed} total={props.contextWindow} onCompact={props.onCompact}
        busy={props.compacting} unknown={props.contextUnknown} disabled={props.running || props.compactAvailable === false} />}
    </div>
    {detailsOpen && <div className="input-bar__details">
      {props.learning && <LearningStatusChip {...props.learning} />}
      {props.onLearningDirectiveChange && <LearningDirectiveMenu value={props.learningDirective} onChange={props.onLearningDirectiveChange} />}
      {isWork && props.onOpenCognition && <button type="button" className="input-bar__cognition-entry" disabled={props.cognitionEnabled === false} onClick={props.onOpenCognition}>聊聊你怎么做报告</button>}
    </div>}
    {(props.running || props.error || (props.viewState !== undefined && props.viewState !== 'idle')) && <ProcessHeader messages={props.messages} running={props.running} error={props.error} workspace={props.workspace} viewState={props.viewState} onStop={props.onStop} />}
  </div>;
}
