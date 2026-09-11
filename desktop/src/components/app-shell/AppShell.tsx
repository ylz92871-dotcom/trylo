// Trylo Desktop — AppShell.
//
// v1.5 layout: top bar (Code / Work) + (left rail | body
// | right rail?).
//
// v1.15.7: the left rail is now a 3-section Cursor-style
// sidebar (Workspaces / Files / Sessions) owned by App.
// The shell just passes the new props through. The
// hidden <input webkitdirectory> is kept as a final
// fallback for browsers that still need it; the primary
// path is tauri-plugin-dialog's `open({ directory: true })`.

import { useEffect, useRef, useState, type CSSProperties, type ReactElement, ReactNode } from 'react';
import { TopBar } from './TopBar';
import { BrowserPreviewPanel } from '../chat/BrowserPreviewPanel';
import { LeftRail, type WorkspaceEntry } from './LeftRail';
import { RightRail } from './RightRail';
import { RailResizer } from './RailResizer';
import { FilePeek } from './FilePeek';
import { GitDiffView, type GitFileDiffData } from '../code-surface/GitDiffView';
import { SettingsModal } from './SettingsModal';
import { RemotePairingModal } from './RemotePairingModal';
import type { FilePath, TopLevelMode } from '../../host-adapter/types';
import type { ConversationSession } from '../../host-adapter/conversation-history';
import type { TryloSettings } from '../../settings/settings-store';
import type { PetStatusSnapshot, RemotePairingInfoResult, RemoteStatusResult } from '../../services-host/methods';
import type { ToolPlatformState } from '../../tooling/use-tool-platform-state';
import type { LearningPort } from '../../learning/learning-port';
import type { BrowserPreviewController } from '../../tooling/use-browser-preview';
import { pickFolder } from '../../host-adapter/pick-folder';
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
  readonly onTopModeChange: (mode: TopLevelMode) => void;
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
  /** Preview-rail width (px), dragged via the peek resizer. */
  readonly peekWidth?: number;
  readonly onPeekWidthChange?: (w: number) => void;
  /** One-click full preview: the rail goes wide until toggled off. */
  readonly peekExpanded?: boolean;
  readonly onTogglePeekExpanded?: () => void;
  /** P2-1 (spec §9.6): an active Git diff right-pane, distinct from a plain
   *  file peek. Rendered in the same right area via a discriminated state. */
  readonly gitDiff?: {
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
  readonly onSettingsSave: (settings: TryloSettings) => void;
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
  readonly remoteController?: { pairing(): Promise<RemotePairingInfoResult> } | null;
  /**
   * 2026-08-29: the TopBar "远程" button opens the remote
   * pairing modal (the new home of the pairing QR). The
   * modal owns enable/disable + QR; this prop only opens it.
   */
  readonly remoteEnabled?: boolean;
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
}

export function AppShell(props: AppShellProps): ReactElement {
  // Hidden <input webkitdirectory> as a fallback for
  // browsers that don't have tauri-plugin-dialog.
  const inputRef = useRef<HTMLInputElement>(null);
  // The embedded browser drawer: ONE shell-level entry, shared by
  // Code and Work. Closing the drawer keeps the browser alive.
  const [browserPreviewOpen, setBrowserPreviewOpen] = useState(false);

  // Allow timeline cards (ToolCard / BrowserWorkflowPanel) to open
  // the preview drawer without lifting state to App: they dispatch
  // `trylo:open-browser-preview`.
  useEffect(() => {
    const onOpen = (): void => {
      if (props.browserPreview) setBrowserPreviewOpen(true);
    };
    window.addEventListener('trylo:open-browser-preview', onOpen as EventListener);
    return () => window.removeEventListener('trylo:open-browser-preview', onOpen as EventListener);
  }, [props.browserPreview]);

  return (
    <div className="app-shell" data-mode={props.topMode} style={props.style}>
      <TopBar
        topMode={props.topMode}
        onTopModeChange={props.onTopModeChange}
        right={props.topBarRight}
        collaborationSwitch={props.topBarCollaborationSwitch}
        onOpenSettings={() => props.onSettingsOpenChange(true)}
        activeCodeRuns={props.activeCodeRuns}
        onOpenActivityCenter={props.onOpenActivityCenter}
        browserPreviewOpen={browserPreviewOpen && props.browserPreview !== undefined}
        onToggleBrowserPreview={
          props.browserPreview ? () => setBrowserPreviewOpen((o) => !o) : undefined
        }
        // 2026-08-29: TopBar "远程" button opens the pairing
        // modal (which holds the QR + enable switch). Detailed
        // config (port / tunnel / URL) stays in Settings.
        remoteEnabled={props.remoteEnabled ?? false}
        remoteRunning={props.remoteRunning ?? false}
        onOpenRemotePairing={() => props.onRemotePairingOpenChange(true)}
        onRemoteToggle={props.onRemoteToggle}
      />
      <div
        className="app-shell__body"
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
          {props.children}
        </div>
        {props.rightRailOpen && (
          <RailResizer
            side="right"
            width={props.rightWidth}
            min={200}
            max={520}
            onChange={props.onRightWidthChange}
          />
        )}
        <RightRail
          open={props.rightRailOpen}
          root={props.fileTreeRoot}
          onClose={props.onToggleRightRail}
          onSelectFile={props.onSelectFile}
        />
        {/* The drag width is ignored while expanded (the expanded class
            owns the width), so the handle hides too — a visible but
            dead handle would be a UI lie. */}
        {props.peekFile && props.onClosePeek && props.onPeekWidthChange && props.peekExpanded !== true && (
          <RailResizer
            side="right"
            width={props.peekWidth ?? 480}
            min={320}
            max={880}
            onChange={props.onPeekWidthChange}
          />
        )}
        {props.peekFile && props.onClosePeek && (
          <FilePeek
            path={props.peekFile.path}
            content={props.peekFile.content}
            width={props.peekExpanded === true ? undefined : (props.peekWidth ?? 480)}
            expanded={props.peekExpanded ?? false}
            onToggleExpanded={props.onTogglePeekExpanded}
            onClose={props.onClosePeek}
          />
        )}
        {props.gitDiff && (
          <GitDiffView
            path={props.gitDiff.path}
            diff={props.gitDiff.diff}
            error={props.gitDiff.error}
            onClose={props.gitDiff.onClose}
          />
        )}
        {props.approvalDiff && (
          <GitDiffView
            path={props.approvalDiff.path}
            diff={props.approvalDiff.diff}
            // P3: explicit "待审批变更" header hint so the user
            // can never confuse this with a committed change.
            error="待审批变更（Diff 仅展示拟修改内容，不会自动批准）"
            onClose={props.approvalDiff.onClose}
          />
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but
        // works in Chromium and in the Tauri webview.
        webkitdirectory=""
        multiple={false}
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = e.target.files;
          if (!files || files.length === 0) return;
          const first = files[0];
          if (!first) return;
          const fileWithPath = first as File & { path?: string };
          const fullPath: string | undefined = fileWithPath.path;
          if (fullPath) {
            const cleaned = fullPath.replace(/[/\\][^/\\]+$/, '');
            void pickFolder; // keep import in use
            // Emit a click on the Open-folder button by
            // dispatching a custom event the App listens
            // for. (No App listener in v1.15.7 — the
            // primary path is pickFolder from the rail.)
            window.dispatchEvent(
              new CustomEvent('trylo:open-folder', {
                detail: { path: cleaned },
              }),
            );
          }
          e.target.value = '';
        }}
      />
      <SettingsModal
        open={props.settingsOpen}
        initial={props.settings}
        onSave={props.onSettingsSave}
        onClose={() => props.onSettingsOpenChange(false)}
        petStatus={props.petStatus}
        remoteStatus={props.remoteStatus}
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
        onRemoteToggle={props.onRemoteToggle}
      />
      {/* The embedded browser drawer — shell-level so the same
          panel serves Code and Work; floats over the main column
          below the top bar. The controller stays mounted while the
          drawer is closed, so the browser survives a re-open. */}
      {props.browserPreview && browserPreviewOpen ? (
        <BrowserPreviewPanel
          preview={props.browserPreview}
          onClose={() => setBrowserPreviewOpen(false)}
        />
      ) : null}
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
