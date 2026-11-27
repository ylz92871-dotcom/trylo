import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactElement, ReactNode } from 'react';
import { TopBar } from './TopBar';
import { BrowserToolSidebar } from '../chat/BrowserToolSidebar';
import { AppWindow, Box, Globe, Monitor, Terminal as TerminalIcon } from 'lucide-react';
import { SoftwareWorkspacePanel } from '../software-workspace/SoftwareWorkspacePanel';
import { useSoftwareWorkspace } from '../../tooling/use-software-workspace';
import type { ChatMessage } from '../chat/types';
import { toolPreviewState } from '../../tooling/tool-preview-state';
import { useBrowserReplay } from '../../tooling/use-browser-replay';
import { useComputerPreview } from '../../tooling/use-computer-preview';
import { useToolWorkbenchLifecycle } from '../../tooling/use-tool-workbench-lifecycle';
import type { ServiceManager } from '../../services-host/service-manager';
import type { ToolingFacade } from '../../tooling/tooling-facade';
import { LeftRail, type WorkspaceEntry } from './LeftRail';
import { RightRail, type RightRailReview } from './RightRail';
import { RailResizer } from './RailResizer';
import { WorkspaceNavigationContext } from './WorkspaceNavigationContext';
import { FilePeek } from './FilePeek';
import { GitDiffView, type GitFileDiffData } from '../code-surface/GitDiffView';
import { SettingsModal, type SettingsTab, type RelayAccountActions } from './SettingsModal';
import type { CollaborationLearningRuntime } from '../../collaboration-learning/cli';
import type { DesktopCollaborationResources } from '../../collaboration-learning/desktop-resources';
import { LibraryProcessRecovery } from './LibraryProcessRecovery';
import { RemotePairingModal } from './RemotePairingModal';
import { useDesktopAccount } from '../../account/use-desktop-account';
import type { FilePath, TopLevelMode } from '../../host-adapter/types';
import { isTauri } from '../../host-adapter/tauri-detect';
import { isMacPlatform, formatShortcut } from '../../utils/platform';
import { prefersReducedMotion, usePresenceTransition } from '../../utils/use-presence-transition';
import type { ConversationSession } from '../../host-adapter/conversation-history';
import type { SettingsSaveIntent, TryloSettings } from '../../settings/settings-store';
import type { SettingsNotice } from '../../settings/settings-notices';
import type { PetStatusSnapshot, RemotePairingInfoResult, RemoteStatusResult } from '../../services-host/methods';
import type { ToolPlatformState } from '../../tooling/use-tool-platform-state';
import type { LearningPort } from '../../learning/learning-port';
import type { SkillLearningRuntime } from '../../skill-learning/cli';
import type { BrowserPreviewController } from '../../tooling/use-browser-preview';
import { useAppearance } from '../../settings/appearance-store';
import {
  BackgroundActivityCenter,
  type ActivityItem,
} from '../activity/BackgroundActivityCenter';

export const DEFAULT_LEFT_RAIL_WIDTH = 240;
export const DEFAULT_RIGHT_RAIL_WIDTH = 320;
export const DEFAULT_RIGHT_RAIL_WIDE_WIDTH = 480;
const Terminal = lazy(() => import('../product-ui/Terminal').then(({ Terminal }) => ({ default: Terminal })));

export interface AppShellProps {
  readonly resultReview?: RightRailReview;
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
  /** Switches between Code and Work top-level workspaces from the unified toolbar. */
  readonly onTopModeChange?: (mode: TopLevelMode) => void;
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
  /** Scene sessions own their lifecycle independently of the selected rail tab. */
  readonly modelPreview?: (onAvailable: (key: number | null) => void, shown: boolean) => ReactNode;
  /** File currently being peeked. */
  readonly peekFile?: { path: FilePath; content: string; resolvedKind?: import('../../preview/formats').PreviewKind; loading?: boolean; error?: string; requestId?: number } | null;
  readonly previewRoot?: string;
  readonly previewFiles?: readonly { readonly path: string; readonly name?: string }[];
  readonly onSelectPreviewFile?: (path: string) => void;
  readonly onReloadPeek?: () => void;
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
  readonly onSettingsNoticeDismissed?: (notice: SettingsNotice) => void;
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
  readonly skillLearningRuntime?: SkillLearningRuntime;
  readonly collaborationLearningRuntime?: CollaborationLearningRuntime;
  readonly collaborationResources?: DesktopCollaborationResources;
  readonly onDiscussCollaborationIssue?: (issueId: string) => void;
  readonly onRequestTemporaryExpert?: () => void;
  readonly libraryApprovals?: readonly ChatMessage[];
  readonly onRespondLibraryApproval?: (id: string, allow: boolean) => void;
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
  readonly shellActionsRef?: MutableRefObject<{
    readonly toggleTerminal: () => void;
    readonly toggleBrowserSidebar: () => void;
  } | null>;
}

export function AppShell(props: AppShellProps): ReactElement {
  useAppearance();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connection');
  const activityTrigger = useRef<HTMLButtonElement>(null);
  const activityPanelId = useId();
  const terminalId = useId();
  const terminalTrigger = useRef<HTMLButtonElement>(null);
  const [terminalWorkspace, setTerminalWorkspace] = useState<string | null>(null);
  const workspace = props.workspaces.find((item) => item.id === props.currentWorkspaceId);
  const mac = isMacPlatform();
  const terminalAvailable = Boolean(workspace?.root) && isTauri() && mac;
  const terminalOpen = terminalAvailable && terminalWorkspace === props.currentWorkspaceId;
  const focusTerminalTrigger = useCallback(() => terminalTrigger.current?.focus(), []);
  const [accountOpenRequest, setAccountOpenRequest] = useState(0);
  const account = useDesktopAccount(props.remoteController, {
    serverUrl: props.settings.remote.relayUrl || 'https://relay.trylocode.me',
    onSessionChanged: async () => {
      const remote = props.settings.remote;
      if ((remote.connectionMode ?? 'server') === 'server' && remote.enabled && props.onRemoteConfigure) {
        await props.onRemoteConfigure({ ...remote, enabled: false });
      }
    },
  });
  // The embedded browser drawer: ONE shell-level entry, shared by
  // Code and Work. Closing the drawer keeps the browser alive.
  const [browserPreviewOpen, setBrowserPreviewOpen] = useState(false);
  const [modelPreviewKey, setModelPreviewKey] = useState<number | null>(null);
  const [modelPreviewOpen, setModelPreviewOpen] = useState(false);
  const [modelPreviewWidth, setModelPreviewWidth] = useState(520);
  const latestDock = useRef({ open: props.rightRailOpen, approval: !!props.approvalDiff, toggle: props.onToggleRightRail });
  latestDock.current = { open: props.rightRailOpen, approval: !!props.approvalDiff, toggle: props.onToggleRightRail };
  const hideSoftware = useRef<() => void>(() => {});
  useEffect(() => {
    if (modelPreviewKey === null) { setModelPreviewOpen(false); return; }
    setModelPreviewOpen(true); setBrowserPreviewOpen(false);
    hideSoftware.current();
    if (latestDock.current.open && !latestDock.current.approval) latestDock.current.toggle();
    // A newly available scene may open the dock once. Later user navigation
    // owns panel visibility, without closing the model's background session.
  }, [modelPreviewKey]);
  const [browserWidth, setBrowserWidth] = useState(480);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [resizingRail, setResizingRail] = useState(false);
  const [leftRailTransitioning, setLeftRailTransitioning] = useState(false);
  const prevLeftCollapsed = useRef(props.leftRailCollapsed);
  const leftSlotRef = useRef<HTMLDivElement>(null);
  const rightSlotRef = useRef<HTMLDivElement>(null);
  const leftRailPresence = usePresenceTransition(!props.leftRailCollapsed, 220);
  const rightRailPresence = usePresenceTransition(props.rightRailOpen, 220);

  useEffect(() => {
    const el = leftSlotRef.current;
    if (!el) return;
    if (props.leftRailCollapsed) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [props.leftRailCollapsed]);

  useEffect(() => {
    const el = rightSlotRef.current;
    if (!el) return;
    if (!props.rightRailOpen) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [props.rightRailOpen]);

  useEffect(() => {
    if (prevLeftCollapsed.current === props.leftRailCollapsed) return;
    prevLeftCollapsed.current = props.leftRailCollapsed;
    if (!browserPreviewOpen || prefersReducedMotion()) return;
    setLeftRailTransitioning(true);
    const timer = window.setTimeout(() => setLeftRailTransitioning(false), 240);
    return () => window.clearTimeout(timer);
  }, [props.leftRailCollapsed, browserPreviewOpen]);

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
  // Dragging a rail changes geometry, not tool history. Keep that projection
  // off the resize path while retaining message/run changes as its inputs.
  const browserState = useMemo(() => toolPreviewState(props.toolMessages ?? [], 'browser', { running: runActive }), [props.toolMessages, runActive]);
  const computerState = useMemo(() => toolPreviewState(props.toolMessages ?? [], 'computer', { running: runActive }), [props.toolMessages, runActive]);
  const previewScope = `${props.currentWorkspaceId}:${props.activeSessionId}:${props.topMode}`;
  const software = useSoftwareWorkspace({ facade: props.toolingFacade, manager: props.serviceManager,
    projectRoot: props.workspaces.find(workspace => workspace.id === props.currentWorkspaceId)?.root,
    conversationId: props.activeSessionId, suspended: props.settingsOpen || props.remotePairingOpen || props.activityOpen });
  const [softwareWidth, setSoftwareWidth] = useState(600);
  hideSoftware.current = () => software.setOpen(false);
  useEffect(() => {
    if (!software.open) return;
    if (latestDock.current.approval) { hideSoftware.current(); return; }
    setBrowserPreviewOpen(false); setModelPreviewOpen(false);
    if (latestDock.current.open) latestDock.current.toggle();
  }, [software.open]);
  const browserReplay = useBrowserReplay(browserState, props.browserPreview, previewScope);
  const workbench = useToolWorkbenchLifecycle({ scope: previewScope, running: runActive, autoOpenComputer: !mac,
    browser: browserState, computer: computerState, onError: setPreviewError,
    showBrowser: () => { software.setOpen(false); setModelPreviewOpen(false); if (props.rightRailOpen) props.onToggleRightRail(); setBrowserPreviewOpen(true); } });
  const macComputerPreviewState = computerState.hasTools
    ? computerState
    : { title: '实时窗口预览', status: '等待工具操作', detail: '从系统面板选择一个窗口。' };
  useComputerPreview(mac ? macComputerPreviewState : computerState, previewScope, { manager: props.serviceManager, facade: props.toolingFacade,
    projectRoot: props.workspaces.find(workspace => workspace.id === props.currentWorkspaceId)?.root,
    conversationId: props.activeSessionId, turnId: mac ? undefined : computerState.turnId,
    display: mac ? undefined : computerState.display,
    enabled: workbench.computerVisible && (mac || (runActive && computerState.hasStarted === true)),
    pickerRequest: mac ? workbench.computerRequest : undefined, excludeWindow: mac ? undefined : workbench.computerHandle });
  const openMacPreview = (): void => {
    setPreviewError('');
    void workbench.openComputer(props.toolingFacade?.prepareComputerPreview);
  };
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
  const setSoftwareOpen = software.setOpen;
  const approvalReview = !!props.approvalDiff;
  useEffect(() => { if (rightRailOpen || approvalReview) setSoftwareOpen(false); }, [rightRailOpen, approvalReview, setSoftwareOpen]);
  useEffect(() => {
    const onOpen = (): void => {
      hideSoftware.current();
      setModelPreviewOpen(false);
      if (rightRailOpen) onToggleRightRail();
      setBrowserPreviewOpen(true);
    };
    window.addEventListener('trylo:open-browser-preview', onOpen as EventListener);
    return () => window.removeEventListener('trylo:open-browser-preview', onOpen as EventListener);
  }, [rightRailOpen, onToggleRightRail]);

  const workspaceNavigation = useMemo(() => ({ workspaces: props.workspaces, currentWorkspaceId: props.currentWorkspaceId,
    onSwitchWorkspace: props.onSwitchWorkspace, onOpenFolder: props.onOpenFolder }),
  [props.workspaces, props.currentWorkspaceId, props.onSwitchWorkspace, props.onOpenFolder]);

  const { shellActionsRef, currentWorkspaceId } = props;
  useEffect(() => {
    if (!shellActionsRef) return;
    shellActionsRef.current = {
      toggleTerminal: () => {
        if (!terminalAvailable) return;
        setTerminalWorkspace((current) => (current === currentWorkspaceId ? null : currentWorkspaceId));
      },
      toggleBrowserSidebar: () => {
        hideSoftware.current();
        setModelPreviewOpen(false);
        setBrowserPreviewOpen((open) => {
          const next = !open;
          if (next && rightRailOpen) onToggleRightRail();
          return next;
        });
      },
    };
    return () => {
      shellActionsRef.current = null;
    };
  }, [shellActionsRef, terminalAvailable, currentWorkspaceId, rightRailOpen, onToggleRightRail]);

  const preview = props.approvalDiff ? (
    <GitDiffView path={props.approvalDiff.path} diff={props.approvalDiff.diff}
      notice="待审批变更（Diff 仅展示拟修改内容，不会自动批准）" onClose={props.approvalDiff.onClose} />
  ) : props.peekFile && props.onClosePeek ? (
    <FilePeek embedded path={props.peekFile.path} content={props.peekFile.content} resolvedKind={props.peekFile.resolvedKind}
      key={`${props.peekFile.path}:${props.peekFile.requestId ?? ''}`} allowedRoot={props.previewRoot} loading={props.peekFile.loading} error={props.peekFile.error} onReload={props.onReloadPeek}
      files={props.previewFiles} onSelectFile={props.onSelectPreviewFile}
      expanded={props.peekExpanded ?? false} onToggleExpanded={props.onTogglePeekExpanded} onClose={props.onClosePeek} />
  ) : props.gitDiff ? (
    <GitDiffView path={props.gitDiff.path} diff={props.gitDiff.diff} error={props.gitDiff.error} onClose={props.gitDiff.onClose} />
  ) : null;
  const previewKey = props.approvalDiff ? `approval:${props.approvalDiff.id ?? props.approvalDiff.path}`
    : props.peekFile ? `file:${props.peekFile.path}:${props.peekFile.requestId ?? ''}`
    : props.gitDiff ? `diff:${props.gitDiff.id ?? props.gitDiff.path}` : null;

  const rightRailWide = Boolean(preview || props.resultReview);
  const effectiveRightWidth = rightRailWide
    ? Math.min(Math.max(props.rightWidth, DEFAULT_RIGHT_RAIL_WIDE_WIDTH), browserMaxWidth)
    : Math.min(props.rightWidth, 420);

  return (
    <WorkspaceNavigationContext.Provider value={workspaceNavigation}>
    <div
      className="app-shell"
      data-mode={props.topMode}
      data-resizing={resizingRail ? 'true' : undefined}
      data-settings-open={props.settingsOpen ? 'true' : undefined}
      style={{
        '--rail-left-w': `${props.leftWidth}px`,
        '--rail-right-w': `${effectiveRightWidth}px`,
        ...(rightRailWide ? { '--rail-content-max': `${browserMaxWidth}px` } : {}),
        ...props.style,
      } as CSSProperties}
    >
      <div
        className="app-shell__body"
        ref={bodyRef}
        data-peek-open={props.peekFile ? 'true' : 'false'}
      >
        <div
          ref={leftSlotRef}
          className="left-rail-slot"
          data-collapsed={props.leftRailCollapsed ? 'true' : 'false'}
          data-motion-state={leftRailPresence.state}
          aria-hidden={props.leftRailCollapsed ? 'true' : undefined}
        >
          {leftRailPresence.mounted && (
            <LeftRail
              workspaces={props.workspaces}
              currentWorkspaceId={props.currentWorkspaceId}
              sessions={props.sessions}
              activeSessionId={props.activeSessionId}
              runningSessionIds={props.runningSessionIds}
              teamMarks={props.teamMarks}
              collapsed={false}
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
              onOpenActivity={props.onOpenActivityCenter ? () => props.activityOpen ? props.onActivityOpenChange?.(false) : props.onOpenActivityCenter?.() : undefined}
              activityTriggerRef={activityTrigger}
              activityOpen={props.activityOpen}
              activityPanelId={activityPanelId}
              activeRuns={props.activityItems?.length ?? props.activeCodeRuns}
              onOpenTools={() => { setSettingsTab('tools'); props.onSettingsOpenChange(true); }}
              onOpenLearning={props.onOpenLearningPending}
              onOpenRemote={() => props.onRemotePairingOpenChange(true)}
              remoteRunning={props.remoteRunning}
              onOpenSettings={() => { setSettingsTab('connection'); props.onSettingsOpenChange(true); }}
              account={account}
              accountOpenRequest={accountOpenRequest}
              accountRemoteActive={(props.settings.remote.connectionMode ?? 'server') === 'server' && (props.remoteEnabled ?? false)}
            />
          )}
        </div>
        {!props.leftRailCollapsed && (
          <RailResizer
            side="left"
            width={props.leftWidth}
            min={mac ? 212 : 184}
            max={360}
            onChange={props.onLeftWidthChange}
            onDraggingChange={setResizingRail}
          />
        )}
        <div className="app-shell__main">
          <TopBar
            workspaceName={workspace?.name ?? 'Trylo'}
            conversationTitle={props.sessions.find((session) => session.id === props.activeSessionId)?.title}
            topMode={props.topMode}
            onTopModeChange={props.onTopModeChange}
            right={<>
              {terminalAvailable && (
                <button
                  type="button"
                  ref={terminalTrigger}
                  className={`top-bar__rail-toggle${terminalOpen ? ' top-bar__rail-toggle--active' : ''}`}
                  aria-label="集成终端"
                  title={mac ? `集成终端 ${formatShortcut(['Control', '`'])}` : '集成终端'}
                  aria-expanded={terminalOpen}
                  aria-controls={terminalOpen ? terminalId : undefined}
                  data-tauri-drag-region={mac ? 'false' : undefined}
                  onClick={() => setTerminalWorkspace(terminalOpen ? null : props.currentWorkspaceId)}
                ><TerminalIcon size={16} aria-hidden="true" /></button>
              )}
              {modelPreviewKey !== null && <button type="button" className={`top-bar__rail-toggle${modelPreviewOpen ? ' top-bar__rail-toggle--active' : ''}`} aria-label="3D 工作区" title="3D 工作区" aria-pressed={modelPreviewOpen} data-tauri-drag-region={mac ? 'false' : undefined} onClick={() => {
                software.setOpen(false);
                if (!modelPreviewOpen) { setBrowserPreviewOpen(false); if (props.rightRailOpen) props.onToggleRightRail(); }
                setModelPreviewOpen(open => !open);
              }}><Box size={16} strokeWidth={1.65} aria-hidden="true" /></button>}
              <button type="button" className={`top-bar__rail-toggle${browserPreviewOpen ? ' top-bar__rail-toggle--active' : ''}`} aria-label="浏览器侧栏" title={mac ? `浏览器侧栏 ${formatShortcut(['Option', 'Mod', 'B'])}` : '浏览器侧栏'} aria-pressed={browserPreviewOpen} data-tauri-drag-region={mac ? 'false' : undefined} onClick={() => {
                software.setOpen(false);
                setModelPreviewOpen(false);
                if (!browserPreviewOpen && props.rightRailOpen) props.onToggleRightRail();
                setBrowserPreviewOpen(open => !open);
              }}><Globe size={16} strokeWidth={1.65} aria-hidden="true" /></button>
              {!mac && <button type="button" className={`top-bar__rail-toggle${software.open ? ' top-bar__rail-toggle--active' : ''}`} aria-label="软件工作区" title="软件工作区" aria-pressed={software.open} onClick={() => software.setOpen(!software.open)}><AppWindow size={16} strokeWidth={1.65} aria-hidden="true" /></button>}
              {mac && isTauri() && props.toolingFacade && props.serviceManager && props.activeSessionId &&
                <button type="button" className="top-bar__rail-toggle" aria-label="实时窗口预览" title="实时窗口预览"
                  data-tauri-drag-region="false" onClick={openMacPreview}>
                  <Monitor size={16} strokeWidth={1.65} aria-hidden="true" />
                </button>}
              {!mac && <button type="button" className={`top-bar__rail-toggle${runActive && computerState.hasTools ? ' top-bar__rail-toggle--active' : ''}`} aria-label={runActive && computerState.hasTools ? '电脑悬浮窗，控制正在工作' : '电脑悬浮窗'} title={runActive && computerState.hasTools ? '电脑控制正在工作' : '电脑悬浮窗'} onClick={() => { setPreviewError(''); void workbench.openComputer(); }}><Monitor size={16} strokeWidth={1.65} aria-hidden="true" />{runActive && computerState.hasTools && <span className="top-bar__activity-dot" aria-hidden="true" />}</button>}
              {props.topBarRight}
            </>}
            collaborationSwitch={props.topBarCollaborationSwitch}
            collapsed={props.leftRailCollapsed}
            onToggleLeftRail={props.onToggleLeftRail}
          />
          {props.children}
          {terminalOpen && workspace?.root && (
            <Suspense fallback={<div id={terminalId} role="status">正在打开终端…</div>}>
              <Terminal
                key={workspace.root}
                cwd={workspace.root}
                id={terminalId}
                onReturnFocus={focusTerminalTrigger}
                onClose={() => setTerminalWorkspace(null)}
              />
            </Suspense>
          )}
        </div>
        {!mac && software.open && !props.rightRailOpen && !props.approvalDiff && <>
          <RailResizer side="right" width={Math.min(softwareWidth, browserMaxWidth)} min={320} max={browserMaxWidth} onChange={setSoftwareWidth} />
          <SoftwareWorkspacePanel controller={software} width={Math.min(softwareWidth, browserMaxWidth)} onClose={() => software.setOpen(false)} />
        </>}
        {modelPreviewOpen && modelPreviewKey !== null && !props.rightRailOpen && !browserPreviewOpen && !software.open && <RailResizer side="right" width={Math.min(modelPreviewWidth, browserMaxWidth)} min={320} max={browserMaxWidth} onChange={setModelPreviewWidth} />}
        <div style={{ display:'contents', '--model-preview-width': `${Math.min(modelPreviewWidth, browserMaxWidth)}px` } as CSSProperties}>
          {props.modelPreview?.(setModelPreviewKey, modelPreviewOpen && !props.rightRailOpen && !browserPreviewOpen && !software.open && !props.settingsOpen && !props.approvalDiff)}
        </div>
        {props.rightRailOpen && props.peekExpanded !== true && (
          <RailResizer
            side="right"
            width={effectiveRightWidth}
            min={rightRailWide ? (props.resultReview ? 320 : 360) : 260}
            max={rightRailWide ? browserMaxWidth : 420}
            onChange={props.onRightWidthChange}
            onDraggingChange={setResizingRail}
          />
        )}
        {browserPreviewOpen && <>
          {!browserFullscreen && <RailResizer side="right" width={shownBrowserWidth} min={320} max={browserMaxWidth} onChange={setBrowserWidth} onDraggingChange={setResizingRail} />}
          <BrowserToolSidebar key={`${previewScope}:${browserState.turnId}`} state={browserState} preview={props.browserPreview} replay={browserReplay}
            width={shownBrowserWidth} running={runActive} fullscreen={browserFullscreen} onToggleFullscreen={() => setBrowserFullscreen(value => !value)}
            suspended={props.settingsOpen || props.remotePairingOpen || props.activityOpen || leftRailTransitioning}
            onClose={() => setBrowserPreviewOpen(false)} />
        </>}
        <div
          ref={rightSlotRef}
          className="right-rail-slot"
          data-open={props.rightRailOpen ? 'true' : 'false'}
          data-wide={rightRailWide ? 'true' : 'false'}
          data-motion-state={rightRailPresence.state}
          aria-hidden={!props.rightRailOpen ? 'true' : undefined}
        >
          {rightRailPresence.mounted && (
            <RightRail
              review={props.resultReview}
              maxWidth={rightRailWide ? browserMaxWidth : undefined}
              open={true}
              preview={preview}
              previewKey={previewKey}
              onExpandPreview={props.peekFile && !props.peekExpanded ? props.onTogglePeekExpanded : undefined}
              root={props.fileTreeRoot}
              onClose={props.onToggleRightRail}
              onSelectFile={props.onSelectFile}
            />
          )}
        </div>
      </div>
      {!props.settingsOpen && props.collaborationResources?.libraryRecovery
        && <LibraryProcessRecovery port={props.collaborationResources.libraryRecovery} floating />}
      <SettingsModal
        open={props.settingsOpen}
        initial={props.settings}
        initialTab={settingsTab}
        onSave={props.onSettingsSave}
        onNoticeDismissed={props.onSettingsNoticeDismissed}
        onClose={() => props.onSettingsOpenChange(false)}
        petStatus={props.petStatus}
        remoteStatus={props.remoteStatus}
        relayAccount={props.remoteController}
        onOpenRemote={() => { props.onSettingsOpenChange(false); props.onRemotePairingOpenChange(true); }}
        toolPlatform={props.toolPlatform}
        toolingFacade={props.toolingFacade}
        learningPort={props.learningPort}
        skillLearningRuntime={props.skillLearningRuntime}
        collaborationLearningRuntime={props.collaborationLearningRuntime}
        collaborationResources={props.collaborationResources}
        onDiscussCollaborationIssue={props.onDiscussCollaborationIssue}
        onRequestTemporaryExpert={props.onRequestTemporaryExpert}
        libraryApprovals={props.libraryApprovals}
        onRespondLibraryApproval={props.onRespondLibraryApproval}
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
        account={account.account}
        accountLoading={account.phase === 'checking'}
        onOpenAccount={() => {
          props.onRemotePairingOpenChange(false);
          if (props.leftRailCollapsed) props.onToggleLeftRail();
          setAccountOpenRequest(value => value + 1);
          void account.refresh();
        }}
      />
      {/* The embedded browser drawer — shell-level so the same
          panel serves Code and Work; floats over the main column
          below the top bar. The controller stays mounted while the
          drawer is closed, so the browser survives a re-open. */}
      {previewError && <div role="alert" className="tool-preview-error" onClick={() => setPreviewError('')}>{previewError}</div>}
      {/* M4-D: Background Activity Center. Floats
          above the chat panel; closing returns focus
          to the trigger. See spec §8.5. */}
      <BackgroundActivityCenter
        id={activityPanelId}
        anchor={activityTrigger.current}
        open={Boolean(props.activityOpen)}
        items={props.activityItems ?? []}
        onClose={() => props.onActivityOpenChange?.(false)}
      />
    </div>
    </WorkspaceNavigationContext.Provider>
  );
}
