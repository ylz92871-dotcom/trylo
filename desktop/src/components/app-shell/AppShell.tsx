import { useEffect, useRef, useState, type CSSProperties, type ReactElement, ReactNode } from 'react';
import { TopBar } from './TopBar';
import { BrowserToolSidebar } from '../chat/BrowserToolSidebar';
import { Globe, Monitor } from 'lucide-react';
import type { ChatMessage } from '../chat/types';
import { toolPreviewState } from '../../tooling/tool-preview-state';
import { useBrowserReplay } from '../../tooling/use-browser-replay';
import { useComputerPreview } from '../../tooling/use-computer-preview';
import { useToolWorkbenchLifecycle } from '../../tooling/use-tool-workbench-lifecycle';
import type { ServiceManager } from '../../services-host/service-manager';
import type { ToolingFacade } from '../../tooling/tooling-facade';
import { LeftRail, type WorkspaceEntry } from './LeftRail';
import { RightRail } from './RightRail';
import { RailResizer } from './RailResizer';
import { FilePeek } from './FilePeek';
import { GitDiffView, type GitFileDiffData } from '../code-surface/GitDiffView';
import { SettingsModal, type SettingsTab, type RelayAccountActions } from './SettingsModal';
import { RemotePairingModal } from './RemotePairingModal';
import type { FilePath, TopLevelMode } from '../../host-adapter/types';
import type { ConversationSession } from '../../host-adapter/conversation-history';
import type { SettingsSaveIntent, TryloSettings } from '../../settings/settings-store';
import type { PetStatusSnapshot, RemotePairingInfoResult, RemoteStatusResult } from '../../services-host/methods';
import type { ToolPlatformState } from '../../tooling/use-tool-platform-state';
import type { LearningPort } from '../../learning/learning-port';
import type { BrowserPreviewController } from '../../tooling/use-browser-preview';
import { useAppearance } from '../../settings/appearance-store';
import {
  BackgroundActivityCenter,
  type ActivityItem,
} from '../activity/BackgroundActivityCenter';

export interface AppShellProps {
  /** All workspaces the user has opened. */
  readonly workspaces: readonly WorkspaceEntry[];
  /** Which workspace the rail is currently showing. */
  readonly currentWorkspaceId: string;
  /** Sessions of the current workspace. */
  readonly sessions: readonly ConversationSession[];
  /** Active session within the current workspace. */
  readonly activeSessionId: string | null;
  /** IDs of sessions currently running (Code or Work). */
  readonly runningSessionIds: ReadonlySet<string>;
  /** Foundation spec §10.6: muted Team mark on session rows. */
  readonly teamMarks?: ReadonlyMap<string, 'active' | 'past'>;

  readonly leftRailCollapsed: boolean;
  readonly onToggleLeftRail: () => void;

  readonly onSwitchWorkspace: (id: string) => void;
  readonly onOpenFolder: () => void;
  readonly onCloseWorkspace: (id: string) => void;
  readonly onSelectSession: (id: string) => void;
  /** No arg — always creates in the current workspace. */
  readonly onNewSession: () => void;
  readonly onDeleteSession: (id: string) => void;
  /** 2026-09-06: rename an existing session's title. Trimmed empty
   *  values are ignored — the title can never be cleared (delete is
   *  the only way to lose the row). */
  readonly onRenameSession: (id: string, title: string) => void;
  /** 2026-09-06: soft-delete a session (kept on disk, hidden from the
   *  active rail list, reachable from the Archived disclosure). */
  readonly onArchiveSession: (id: string) => void;
  /** 2026-09-06: bring a previously-archived session back. */
  readonly onUnarchiveSession: (id: string) => void;

  readonly topMode: TopLevelMode;
  /** Content for the right side of the top bar. */
  readonly topBarRight?: ReactNode;
  /** Person | Team surface (spec §1.2): a second segmented control
   *  rendered in the top bar's right region, before `topBarRight`. */
  readonly topBarCollaborationSwitch?: ReactNode;
  /** M4-D: count of in-flight Code runs across all
   *  conversations. Drives the TopBar activity chip. */
  readonly activeCodeRuns?: number;
  /** M4-D: opens the Background Activity Center. */
  readonly onOpenActivityCenter?: () => void;
  /** M4-D: Background Activity Center popover state. */
  readonly activityOpen?: boolean;
  readonly onActivityOpenChange?: (open: boolean) => void;
  /**
   * M4-D: items rendered inside the Activity Center.
   * The host (App.tsx) maps the Code supervisor's
   * active runs and the Work task registry's
   * non-terminal tasks into a unified ActivityItem
   * list. The shell only renders.
   */
  readonly activityItems?: readonly ActivityItem[];
  /** The main content (the chat panel). */
  readonly children: ReactNode;
  /** File currently being peeked. */
  readonly peekFile?: { path: FilePath; content: string } | null;
  readonly onClosePeek?: () => void;
  /** One-click full preview: the rail goes wide until toggled off. */
  readonly peekExpanded?: boolean;
  readonly onTogglePeekExpanded?: () => void;
  /** P2-1 (spec §9.6): an active Git diff right-pane, distinct from a plain
   *  file peek. Rendered in the same right area via a discriminated state. */
  readonly gitDiff?: {
    readonly id?: string;
    readonly path: string;
    readonly diff?: GitFileDiffData;
    readonly error?: string;
    readonly onClose: () => void;
  } | null;
  /** P3 (spec §3.3): a pending-approval diff. The same GitDiffView
   *  renderer is reused; only the title + an `approvalSource` hint
   *  differ. Rendered with priority over a plain `gitDiff` so the
   *  user sees the proposed change on top of the workspace diff. */
  readonly approvalDiff?: {
    readonly id?: string;
    readonly path: string;
    readonly source: 'code' | 'work';
    readonly diff?: GitFileDiffData;
    readonly onClose: () => void;
  } | null;
  /** Settings to seed the modal with. */
  readonly settings: TryloSettings;
  /** Click a file in the workspace tree. */
  readonly onSelectFile?: (path: FilePath, kind: 'file' | 'dir') => void;
  /** v1.17: the file tree moved out of the left rail into this
   *  toggleable right rail. `fileTreeRoot` is the current
   *  workspace's root; `rightRailOpen` drives visibility. */
  readonly fileTreeRoot: FilePath | null;
  readonly rightRailOpen: boolean;
  readonly onToggleRightRail: () => void;
  /** v1.17.1: live widths (px) for the rails, driven by the
   *  draggable resizers. Applied as CSS custom properties on the
   *  shell root so the rails pick them up without re-render churn. */
  readonly leftWidth: number;
  readonly onLeftWidthChange: (w: number) => void;
  readonly rightWidth: number;
  readonly onRightWidthChange: (w: number) => void;
  /** Optional inline style, used to inject the live rail widths. */
  readonly style?: CSSProperties;
  /** v1.16.5: Phase 2.5 收口 — settings modal state is
   *  owned by App so any descendant (the Work API-key
   *  banner, future deep links, etc.)
   *  can request it. The shell only renders. */
  readonly settingsOpen: boolean;
  readonly onSettingsOpenChange: (open: boolean) => void;
  readonly onSettingsSave: (settings: TryloSettings, intent?: SettingsSaveIntent) => void;
  /** Real pet state, shown in the settings modal (audit §4.2 PET-P0-1). */
  readonly petStatus?: PetStatusSnapshot;
  /** Real remote-gateway state, shown in the settings modal (spec §8.1.4). */
  readonly remoteStatus?: RemoteStatusResult | null;
  /** P0-A (audit §3.3): the Work tool packages' health + install actions,
   *  rendered as the 「Work 工具」 settings section. Absent = not wired. */
  readonly toolPlatform?: ToolPlatformState | null;
  /** Hermes learning port — forwarded to the Settings modal so the
   *  Skills library dialog can list/view installed skills. */
  readonly learningPort?: LearningPort | null;
  /** Opens the Learning panel on the pending-approval tab. */
  readonly onOpenLearningPending?: () => void;
  /** Surface for on-demand remote pairing (QR). */
  readonly remoteController?: { pairing(): Promise<RemotePairingInfoResult> } & RelayAccountActions | null;
  /**
   * 2026-08-29: the TopBar "远程" button opens the remote
   * pairing modal (the new home of the pairing QR). The
   * modal owns enable/disable + QR; this prop only opens it.
   */
  readonly remoteEnabled?: boolean;
  readonly onRemoteConfigure?: (settings: TryloSettings['remote']) => Promise<void>;
  readonly remoteRunning?: boolean;
  /** Open-state for the remote pairing modal (owned by App). */
  readonly remotePairingOpen: boolean;
  readonly onRemotePairingOpenChange: (open: boolean) => void;
  /** Forwarded into the pairing modal's enable switch. */
  readonly onRemoteToggle?: () => void;
  /** The embedded browser panel controller (App-owned). One top-bar
   *  globe icon + one shell-level drawer shared by Code AND Work
   *  (2026-09-04 lightening pass). Absent → no icon, no panel. */
  readonly browserPreview?: BrowserPreviewController;
  readonly toolMessages?: readonly ChatMessage[];
  readonly serviceManager?: ServiceManager | null;
  readonly toolingFacade?: ToolingFacade | null;
}

export function AppShell(props: AppShellProps): ReactElement {
  useAppearance();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connection');
  // The embedded browser drawer: ONE shell-level entry, shared by
  // Code and Work. Closing the drawer keeps the browser alive.
  const [browserPreviewOpen, setBrowserPreviewOpen] = useState(false);
  const [browserWidth, setBrowserWidth] = useState(480);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [bodyWidth, setBodyWidth] = useState(window.innerWidth);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const observer = new ResizeObserver(() => setBodyWidth(body.getBoundingClientRect().width));
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
  const browserMaxWidth = Math.max(320, bodyWidth - (props.leftRailCollapsed ? 40 : props.leftWidth + 5) - 360 - 5);
  const shownBrowserWidth = Math.min(browserWidth, browserMaxWidth);
  useEffect(() => {
    if (!browserPreviewOpen) setBrowserFullscreen(false);
  }, [browserPreviewOpen]);
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setBrowserFullscreen(false); };
    window.addEventListener('keydown', escape);
    const nativeEscape = (): void => setBrowserFullscreen(false);
    window.addEventListener('trylo:exit-browser-fullscreen', nativeEscape);
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('trylo:exit-browser-fullscreen', nativeEscape); };
  }, []);
  const setBrowserVisible = props.browserPreview?.setVisible;
  useEffect(() => { setBrowserVisible?.(browserPreviewOpen); }, [browserPreviewOpen, setBrowserVisible]);
  const [previewError, setPreviewError] = useState('');
  const runActive = props.activeSessionId !== null && props.runningSessionIds.has(props.activeSessionId);
  const browserState = toolPreviewState(props.toolMessages ?? [], 'browser', { running: runActive });
  const computerState = toolPreviewState(props.toolMessages ?? [], 'computer', { running: runActive });
  const previewScope = `${props.currentWorkspaceId}:${props.activeSessionId}:${props.topMode}`;
  const browserReplay = useBrowserReplay(browserState, props.browserPreview, previewScope);
  const workbench = useToolWorkbenchLifecycle({ scope: previewScope, running: runActive,
    browser: browserState, computer: computerState, onError: setPreviewError,
    showBrowser: () => { if (props.rightRailOpen) props.onToggleRightRail(); setBrowserPreviewOpen(true); } });
  useComputerPreview(computerState, previewScope, { manager: props.serviceManager, facade: props.toolingFacade,
    projectRoot: props.workspaces.find(workspace => workspace.id === props.currentWorkspaceId)?.root,
    conversationId: props.activeSessionId, turnId: computerState.turnId, display: computerState.display,
    enabled: runActive && computerState.hasStarted === true && workbench.computerVisible,
    excludeWindow: workbench.computerHandle });
  useEffect(() => { if (props.rightRailOpen) setBrowserPreviewOpen(false); }, [props.rightRailOpen]);
  useEffect(() => {
    const close = (): void => setBrowserPreviewOpen(false);
    window.addEventListener('trylo:close-browser-preview', close);
    return () => window.removeEventListener('trylo:close-browser-preview', close);
  }, []);

  // Allow timeline cards (ToolCard / BrowserWorkflowPanel) to open
  // the preview drawer without lifting state to App: they dispatch
  // `trylo:open-browser-preview`.
  const { rightRailOpen, onToggleRightRail } = props;
  useEffect(() => {
    const onOpen = (): void => {
      if (rightRailOpen) onToggleRightRail();
      setBrowserPreviewOpen(true);
    };
    window.addEventListener('trylo:open-browser-preview', onOpen as EventListener);
    return () => window.removeEventListener('trylo:open-browser-preview', onOpen as EventListener);
  }, [rightRailOpen, onToggleRightRail]);

  const preview = props.approvalDiff ? (
    <GitDiffView path={props.approvalDiff.path} diff={props.approvalDiff.diff}
      notice="待审批变更（Diff 仅展示拟修改内容，不会自动批准）" onClose={props.approvalDiff.onClose} />
  ) : props.peekFile && props.onClosePeek ? (
    <FilePeek path={props.peekFile.path} content={props.peekFile.content}
      expanded={props.peekExpanded ?? false} onToggleExpanded={props.peekExpanded ? props.onTogglePeekExpanded : undefined} onClose={props.onClosePeek} />
  ) : props.gitDiff ? (
    <GitDiffView path={props.gitDiff.path} diff={props.gitDiff.diff} error={props.gitDiff.error} onClose={props.gitDiff.onClose} />
  ) : null;
  const previewKey = props.approvalDiff ? `approval:${props.approvalDiff.id ?? props.approvalDiff.path}`
    : props.peekFile ? `file:${props.peekFile.path}`
    : props.gitDiff ? `diff:${props.gitDiff.id ?? props.gitDiff.path}` : null;

  return (
    <div className="app-shell" data-mode={props.topMode} style={props.style}>
      <div
        className="app-shell__body"
        ref={bodyRef}
        data-peek-open={props.peekFile ? 'true' : 'false'}
      >
        <LeftRail
          workspaces={props.workspaces}
          currentWorkspaceId={props.currentWorkspaceId}
          sessions={props.sessions}
          activeSessionId={props.activeSessionId}
          runningSessionIds={props.runningSessionIds}
          teamMarks={props.teamMarks}
          collapsed={props.leftRailCollapsed}
          onSwitchWorkspace={props.onSwitchWorkspace}
          onOpenFolder={props.onOpenFolder}
          onCloseWorkspace={props.onCloseWorkspace}
          onSelectSession={props.onSelectSession}
          onNewSession={props.onNewSession}
          onDeleteSession={props.onDeleteSession}
          onRenameSession={props.onRenameSession}
          onArchiveSession={props.onArchiveSession}
          onUnarchiveSession={props.onUnarchiveSession}
          onToggleCollapse={props.onToggleLeftRail}
          onOpenActivity={props.onOpenActivityCenter}
          activeRuns={props.activityItems?.length ?? props.activeCodeRuns}
          onOpenTools={() => { setSettingsTab('tools'); props.onSettingsOpenChange(true); }}
          onOpenLearning={props.onOpenLearningPending}
          onOpenRemote={() => props.onRemotePairingOpenChange(true)}
          remoteRunning={props.remoteRunning}
          onOpenSettings={() => { setSettingsTab('connection'); props.onSettingsOpenChange(true); }}
        />
        {!props.leftRailCollapsed && (
          <RailResizer
            side="left"
            width={props.leftWidth}
            min={180}
            max={440}
            onChange={props.onLeftWidthChange}
          />
        )}
        <div className="app-shell__main">
          <TopBar
            workspaceName={props.workspaces.find((ws) => ws.id === props.currentWorkspaceId)?.name ?? 'Trylo'}
            conversationTitle={props.sessions.find((session) => session.id === props.activeSessionId)?.title}
            right={<>
              <button type="button" className={`top-bar__rail-toggle${browserPreviewOpen ? ' top-bar__rail-toggle--active' : ''}`} aria-label="浏览器侧栏" title="浏览器侧栏" aria-pressed={browserPreviewOpen} onClick={() => {
                if (!browserPreviewOpen && props.rightRailOpen) props.onToggleRightRail();
                setBrowserPreviewOpen(open => !open);
              }}><Globe size={16} /><span>浏览器</span></button>
              <button type="button" className={`top-bar__rail-toggle${runActive && computerState.hasTools ? ' top-bar__rail-toggle--active' : ''}`} aria-label="电脑悬浮窗" title={runActive && computerState.hasTools ? '电脑控制正在工作' : '电脑悬浮窗'} onClick={() => { setPreviewError(''); void workbench.openComputer(); }}><Monitor size={16} /><span>{runActive && computerState.hasTools ? '电脑工作中' : '电脑'}</span></button>
              {props.topBarRight}
            </>}
            collaborationSwitch={props.topBarCollaborationSwitch}
            collapsed={props.leftRailCollapsed}
            onToggleLeftRail={props.onToggleLeftRail}
          />
          {props.children}
        </div>
        {props.rightRailOpen && props.peekExpanded !== true && (
          <RailResizer
            side="right"
            width={props.rightWidth}
            min={200}
            max={520}
            onChange={props.onRightWidthChange}
          />
        )}
        {browserPreviewOpen && <>
          {!browserFullscreen && <RailResizer side="right" width={shownBrowserWidth} min={320} max={browserMaxWidth} onChange={setBrowserWidth} />}
          <BrowserToolSidebar key={`${previewScope}:${browserState.turnId}`} state={browserState} preview={props.browserPreview} replay={browserReplay}
            width={shownBrowserWidth} running={runActive} fullscreen={browserFullscreen} onToggleFullscreen={() => setBrowserFullscreen(value => !value)}
            suspended={props.settingsOpen || props.remotePairingOpen || props.activityOpen}
            onClose={() => setBrowserPreviewOpen(false)} />
        </>}
        <RightRail
          open={props.rightRailOpen}
          preview={preview}
          previewKey={previewKey}
          onExpandPreview={props.peekFile && !props.peekExpanded ? props.onTogglePeekExpanded : undefined}
          root={props.fileTreeRoot}
          onClose={props.onToggleRightRail}
          onSelectFile={props.onSelectFile}
        />
      </div>
      <SettingsModal
        open={props.settingsOpen}
        initial={props.settings}
        initialTab={settingsTab}
        onSave={props.onSettingsSave}
        onClose={() => props.onSettingsOpenChange(false)}
        petStatus={props.petStatus}
        remoteStatus={props.remoteStatus}
        relayAccount={props.remoteController}
        onOpenRemote={() => { props.onSettingsOpenChange(false); props.onRemotePairingOpenChange(true); }}
        toolPlatform={props.toolPlatform}
        learningPort={props.learningPort}
        onOpenLearningPending={props.onOpenLearningPending}
      />
      <RemotePairingModal
        open={props.remotePairingOpen}
        onClose={() => props.onRemotePairingOpenChange(false)}
        remoteStatus={props.remoteStatus}
        remoteController={props.remoteController}
        remoteEnabled={props.remoteEnabled ?? false}
        remoteSettings={props.settings.remote}
        onConfigure={props.onRemoteConfigure}
        onRemoteToggle={props.onRemoteToggle}
      />
      {/* The embedded browser drawer — shell-level so the same
          panel serves Code and Work; floats over the main column
          below the top bar. The controller stays mounted while the
          drawer is closed, so the browser survives a re-open. */}
      {previewError && <div role="alert" className="tool-preview-error" onClick={() => setPreviewError('')}>{previewError}</div>}
      {/* M4-D: Background Activity Center. Floats
          above the chat panel; closing returns focus
          to the trigger. See spec §8.5. */}
      {props.activityOpen && (
        <BackgroundActivityCenter
          open={props.activityOpen}
          items={props.activityItems ?? []}
          onClose={() => props.onActivityOpenChange?.(false)}
        />
      )}
    </div>
  );
}
