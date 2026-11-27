import { Logo } from '../brand/Logo';
import { SessionRow } from './SessionRow';
import { WorkspaceFolderIcon } from './WorkspaceFolderIcon';
import { ProfileCard, ProfileAvatarView } from './ProfileCard';
import { LeftRailActivityPane } from './LeftRailActivityPane';
import { LeftRailToolsPane } from './LeftRailToolsPane';
import type { ActivityItem } from '../activity/BackgroundActivityCenter';
import type { ToolPlatformState } from '../../tooling/use-tool-platform-state';
import type { LearningPort } from '../../learning/learning-port';
import type { SkillLearningRuntime } from '../../skill-learning/cli';
import {
  Archive,
  Blocks,
  ChevronDown,
  ChevronRight,
  House,
  Layers2,
  ListFilter,
  PanelLeft,
  Plus,
  RadioTower,
  Search,
  Settings2,
  Sparkles,
  SquarePen,
  X,
} from 'lucide-react';
import { ConfirmDialog } from '../feedback/ConfirmDialog';
import { pushToast } from '../feedback/toast-store';
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type Ref,
} from 'react';
import type { ConversationSession } from '../../host-adapter/conversation-history';
import { useUserProfile } from '../../user-profile/use-user-profile';
import type { DesktopAccountModel } from '../../account/desktop-account';
import {
  isInteractiveTitlebarTarget,
  revealWorkspaceDirectory,
  showNativeContextMenu,
  toggleNativeWindowZoom,
} from '../../host-adapter/native-shell';
import { isTauri } from '../../host-adapter/tauri-detect';
import { formatShortcut, isMacPlatform } from '../../utils/platform';

const PINNED_SESSIONS_STORAGE_KEY = 'trylo:pinned-sessions:v1';

export type LeftRailPane = 'projects' | 'activity' | 'tools';

type CategoryFilter = 'all' | 'code' | 'work' | 'running';

function readPinnedMap(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(PINNED_SESSIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) out[k] = v.filter((item): item is string => typeof item === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

function loadPinnedIds(workspaceId: string): ReadonlySet<string> {
  const map = readPinnedMap();
  return new Set(map[workspaceId] ?? []);
}

function savePinnedIds(workspaceId: string, ids: ReadonlySet<string>): void {
  try {
    const map = readPinnedMap();
    if (ids.size === 0) delete map[workspaceId];
    else map[workspaceId] = [...ids];
    window.localStorage.setItem(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota / privacy mode failures; pin state remains live in memory.
  }
}

/** Shape of a workspace the rail needs. Defined here so
 *  LeftRail is self-contained; App.tsx re-exports the
 *  canonical Workspace type. */
export interface WorkspaceEntry {
  readonly id: string;
  readonly root: string;
  readonly name: string;
}

export interface LeftRailProps {
  /** All workspaces the user has opened. */
  readonly workspaces: readonly WorkspaceEntry[];
  /** The workspace whose sessions are shown right now. */
  readonly currentWorkspaceId: string;
  /** Sessions for the current workspace (filtered upstream). The
   *  rail partitions them into live vs archived by `archivedAt`. */
  readonly sessions: readonly ConversationSession[];
  /** Currently active session within the current workspace. */
  readonly activeSessionId: string | null;
  /** IDs of sessions that are currently running (Code or Work). */
  readonly runningSessionIds: ReadonlySet<string>;
  /** Foundation spec §10.6: personConversationId → 'active' | 'past'.
   *  Derived from team-runs.json only — the conversation kind is NOT
   *  changed and the list is NOT filtered. Undefined = today's look. */
  readonly teamMarks?: ReadonlyMap<string, 'active' | 'past'>;

  readonly collapsed: boolean;

  readonly onSwitchWorkspace: (id: string) => void;
  readonly onOpenFolder: () => void;
  readonly onCloseWorkspace: (id: string) => void;
  readonly onSelectSession: (id: string) => void;
  readonly onNewSession: () => void;
  readonly onDeleteSession: (id: string) => void;
  /** 2026-09-06: rename a session's title from the inline editor. */
  readonly onRenameSession: (id: string, title: string) => void;
  /** 2026-09-06: archive (soft-delete) the row. */
  readonly onArchiveSession: (id: string) => void;
  /** 2026-09-06: bring a previously archived row back into the
   *  active list. */
  readonly onUnarchiveSession: (id: string) => void;
  readonly onToggleCollapse: () => void;
  readonly activePane?: LeftRailPane;
  readonly onActivePaneChange?: (pane: LeftRailPane) => void;
  readonly activityItems?: readonly ActivityItem[];
  readonly toolPlatform?: ToolPlatformState | null;
  readonly learningPort?: LearningPort | null;
  readonly skillLearningRuntime?: SkillLearningRuntime;
  readonly workBrowserDebug?: boolean;
  readonly workCad?: boolean;
  readonly onOpenToolsSettings?: () => void;
  readonly onOpenActivity?: () => void;
  readonly activityOpen?: boolean;
  readonly activityPanelId?: string;
  readonly activityTriggerRef?: Ref<HTMLButtonElement>;
  readonly activeRuns?: number;
  readonly onOpenTools?: () => void;
  readonly onOpenLearning?: () => void;
  readonly onOpenRemote?: () => void;
  readonly remoteRunning?: boolean;
  readonly onOpenSettings?: () => void;
  readonly onGoHome?: () => void;
  readonly toolsOpen?: boolean;
  readonly learningOpen?: boolean;
  readonly remoteOpen?: boolean;
  readonly settingsOpen?: boolean;
  readonly account?: DesktopAccountModel;
  readonly accountOpenRequest?: number;
  readonly accountRemoteActive?: boolean;
}

export function LeftRail(props: LeftRailProps): ReactElement | null {
  const [internalPane, setInternalPane] = useState<LeftRailPane>('projects');
  const currentPane = props.activePane ?? internalPane;
  const selectPane = (pane: LeftRailPane): void => {
    setInternalPane(pane);
    props.onActivePaneChange?.(pane);
  };
  const [hoverSessionId, setHoverSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  // 2026-09-06: the Archived disclosure lives per-active-workspace but
  // is closed by default — the user opens it the first time they need
  // to recover something. Persisted across re-renders but not across
  // workspace switches (the closest sane per-project choice would be a
  // Set<workspaceId> stored on the workspace index; not worth it now).
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(() => loadPinnedIds(props.currentWorkspaceId));
  const searchInputRef = useRef<HTMLInputElement>(null);
  // User identity card (nickname / bio / avatar). Self-contained:
  // loads and saves through the profile store, no App plumbing.
  const profile = useUserProfile();
  const [pendingDeleteSession, setPendingDeleteSession] = useState<ConversationSession | null>(null);
  // The ProfileCard is portalled to <body> and anchored to the avatar
  // button wrapper's rect so it overflows cleanly without clipping.
  const profileRowRef = useRef<HTMLDivElement>(null);
  const openProfile = profile.open;
  useEffect(() => {
    if (props.accountOpenRequest) openProfile();
  }, [props.accountOpenRequest, openProfile]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  // v1.17.1: a project row itself is the dropdown — clicking it
  // expands / collapses its session list (no separate "Sessions"
  // toggle). The active project starts expanded.
  const [expandedId, setExpandedId] = useState<string | null>(props.currentWorkspaceId);

  // Keep the active project expanded when the workspace changes
  // (e.g. via Open folder) so its sessions are always visible.
  useEffect(() => {
    setExpandedId(props.currentWorkspaceId);
    // Drop the editing state when the user switches projects —
    // otherwise they'd land on a project and see a phantom input.
    setEditingSessionId(null);
    setPinnedIds(loadPinnedIds(props.currentWorkspaceId));
  }, [props.currentWorkspaceId]);

  if (props.collapsed) return null;

  const mac = isMacPlatform();

  const onHeaderDoubleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!mac || isInteractiveTitlebarTarget(event.target)) return;
    void toggleNativeWindowZoom();
  };

  const onWorkspaceContextMenu = (
    event: MouseEvent<HTMLDivElement>,
    ws: WorkspaceEntry,
    active: boolean,
  ): void => {
    if (!mac || !isTauri()) return;
    event.preventDefault();
    event.stopPropagation();

    void showNativeContextMenu([
      {
        id: 'primary',
        label: active ? '新建任务' : '切换到此项目',
      },
      { id: 'reveal', label: '在 Finder 中显示' },
      { id: 'sep-1', label: '', separator: true },
      {
        id: 'close',
        label: '关闭工作区',
        enabled: props.workspaces.length > 1,
      },
    ]).then((choice) => {
      if (choice === 'primary') {
        if (active) props.onNewSession();
        else toggleProject(ws.id);
      } else if (choice === 'reveal') {
        void revealWorkspaceDirectory(ws.root);
      } else if (choice === 'close') {
        props.onCloseWorkspace(ws.id);
      }
    });
  };

  const toggleProject = (wsId: string): void => {
    if (expandedId === wsId) {
      // Clicking the already-open project collapses it.
      setExpandedId(null);
    } else {
      props.onSwitchWorkspace(wsId);
      setExpandedId(wsId);
    }
  };

  const requestDeleteSession = (id: string): void => {
    const target = props.sessions.find((s) => s.id === id);
    if (target) setPendingDeleteSession(target);
  };

  const handleArchiveSession = (id: string): void => {
    const target = props.sessions.find((s) => s.id === id);
    props.onArchiveSession(id);
    if (target) {
      pushToast({
        id: `archive:${id}`,
        tone: 'info',
        title: `已归档「${target.title}」`,
        action: {
          label: '撤销',
          onAction: () => props.onUnarchiveSession(id),
        },
        durationMs: 5500,
      });
    }
  };

  const togglePinSession = (id: string): void => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      savePinnedIds(props.currentWorkspaceId, next);
      return next;
    });
  };

  const clearFilters = (): void => {
    setCategoryFilter('all');
    setSearchQuery('');
    setSearchOpen(false);
    setFilterOpen(false);
  };

  const handleGoHome = (): void => {
    profile.close();
    clearFilters();
    setProjectsOpen(true);
    setExpandedId(props.currentWorkspaceId);
    selectPane('projects');
    props.onGoHome?.();
  };

  // Partition once per render so the JSX below stays readable.
  const liveSessions = props.sessions.filter((s) => !s.archivedAt);
  const archivedSessions = props.sessions.filter((s) => !!s.archivedAt);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchesCategory = (s: ConversationSession): boolean => {
    if (categoryFilter === 'code') return s.kind === 'code';
    if (categoryFilter === 'work') return s.kind === 'work';
    if (categoryFilter === 'running') return props.runningSessionIds.has(s.id);
    return true;
  };
  const matchesQuery = (s: ConversationSession, workspaceMatchesName: boolean): boolean =>
    normalizedQuery.length === 0 ||
    workspaceMatchesName ||
    s.title.toLowerCase().includes(normalizedQuery);
  const currentWs = props.workspaces.find((ws) => ws.id === props.currentWorkspaceId);
  const currentWsNameMatches = currentWs
    ? normalizedQuery.length > 0 &&
      (currentWs.name.toLowerCase().includes(normalizedQuery) ||
        currentWs.root.toLowerCase().includes(normalizedQuery))
    : false;
  const filteredLiveSessions = liveSessions.filter(
    (s) => matchesCategory(s) && matchesQuery(s, currentWsNameMatches),
  );
  const filteredArchivedSessions = archivedSessions.filter(
    (s) => matchesCategory(s) && matchesQuery(s, currentWsNameMatches),
  );
  const pinnedSessions = filteredLiveSessions.filter((s) => pinnedIds.has(s.id));
  const unpinnedSessions = filteredLiveSessions.filter((s) => !pinnedIds.has(s.id));
  const hasArchived = filteredArchivedSessions.length > 0;

  const filteredWorkspaces =
    normalizedQuery.length === 0
      ? props.workspaces
      : props.workspaces.filter((ws) => {
          const nameMatches =
            ws.name.toLowerCase().includes(normalizedQuery) ||
            ws.root.toLowerCase().includes(normalizedQuery);
          if (nameMatches) return true;
          if (ws.id === props.currentWorkspaceId) {
            return filteredLiveSessions.length > 0 || filteredArchivedSessions.length > 0;
          }
          return false;
        });

  const profileOpen = profile.step !== 'closed';
  const modalOverlayOpen = Boolean(
    props.learningOpen || props.remoteOpen || props.settingsOpen || profileOpen || props.toolsOpen || props.activityOpen,
  );
  const homeActive = currentPane === 'projects' && !modalOverlayOpen;
  const activityActive = currentPane === 'activity' || Boolean(props.activityOpen);
  const toolsActive = currentPane === 'tools' || Boolean(props.toolsOpen);
  const showLearningOrRemote = Boolean(props.onOpenLearning || props.onOpenRemote);
  const showSettingsOrProfile = Boolean(props.onOpenSettings || props.account);
  const activeRuns = props.activityItems?.length ?? props.activeRuns ?? 0;

  const renderSessionRow = (s: ConversationSession, pinned: boolean): ReactElement => (
    <SessionRow
      key={s.id}
      session={s}
      isActive={s.id === props.activeSessionId}
      isRunning={props.runningSessionIds.has(s.id)}
      teamMark={props.teamMarks?.get(s.id) ?? null}
      isEditing={editingSessionId === s.id}
      isPinned={pinned}
      hoverSessionId={hoverSessionId}
      setHoverSessionId={setHoverSessionId}
      onSelect={props.onSelectSession}
      onDelete={requestDeleteSession}
      onArchive={handleArchiveSession}
      onTogglePin={togglePinSession}
      onStartEdit={(id) => {
        setEditingSessionId(id);
        setHoverSessionId(null);
      }}
      onCommitEdit={(id, title) => {
        props.onRenameSession(id, title);
        setEditingSessionId(null);
      }}
      onCancelEdit={() => setEditingSessionId(null)}
    />
  );

  return (
    <aside
      className="left-rail"
      aria-label="Workspaces and sessions"
      style={{ position: 'relative' }}
    >
      {mac ? (
        <div className="left-rail__header" data-tauri-drag-region="" onDoubleClick={onHeaderDoubleClick}>
          <button
            type="button"
            className="left-rail__collapse"
            onClick={props.onToggleCollapse}
            title={`收起侧栏 ${formatShortcut(['Mod', 'B'])}`}
            aria-label="Collapse rail"
            data-tauri-drag-region="false"
          >
            <PanelLeft size={16} />
          </button>
          <div className="left-rail__brand" data-startup-logo data-tauri-drag-region="">
            <Logo size={22} tone="cream" variant="solid" withBg decorative />
            <span data-tauri-drag-region="">Trylo</span>
          </div>
        </div>
      ) : (
        <div className="left-rail__header">
          <div className="left-rail__brand" data-startup-logo><Logo size={40} tone="cream" variant="solid" withBg decorative /><span>Trylo</span></div>
          <button type="button" className="left-rail__collapse" onClick={props.onToggleCollapse} title="收起侧栏" aria-label="Collapse rail"><PanelLeft size={16} /></button>
        </div>
      )}

      <div className="left-rail__split">
        <nav className="left-rail__dock" aria-label="主导航">
          <div className="left-rail__dock-group">
            <button
              type="button"
              className={`left-rail__dock-btn${homeActive ? ' left-rail__dock-btn--active' : ''}`}
              onClick={handleGoHome}
              aria-label="主页"
              title="主页"
              aria-pressed={currentPane === 'projects'}
              aria-current={homeActive ? 'page' : undefined}
            >
              <House size={18} strokeWidth={1.7} />
            </button>
            <button
              ref={props.activityTriggerRef}
              type="button"
              className={`left-rail__dock-btn${activityActive ? ' left-rail__dock-btn--active' : ''}`}
              onClick={() => {
                profile.close();
                selectPane('activity');
                props.onOpenActivity?.();
              }}
              aria-label="运行中的任务"
              title={activeRuns > 0 ? `运行中的任务 (${activeRuns})` : '运行中的任务'}
              aria-pressed={activityActive}
              aria-current={currentPane === 'activity' && !modalOverlayOpen ? 'page' : undefined}
            >
              <Layers2 size={18} strokeWidth={1.7} />
              {activeRuns > 0 && (
                <span className="left-rail__dock-badge" aria-hidden="true">
                  {activeRuns > 9 ? '9+' : activeRuns}
                </span>
              )}
            </button>
            <button
              type="button"
              className={`left-rail__dock-btn${toolsActive ? ' left-rail__dock-btn--active' : ''}`}
              onClick={() => {
                profile.close();
                selectPane('tools');
                props.onOpenTools?.();
              }}
              aria-label="工具与技能"
              title="工具与技能"
              aria-pressed={toolsActive}
              aria-current={currentPane === 'tools' && !modalOverlayOpen ? 'page' : undefined}
            >
              <Blocks size={18} strokeWidth={1.7} />
            </button>
          </div>

          {(showLearningOrRemote || showSettingsOrProfile) && (
            <div className="left-rail__dock-footer">
              {props.onOpenLearning && (
                <button
                  type="button"
                  className={`left-rail__dock-btn${props.learningOpen ? ' left-rail__dock-btn--active' : ''}`}
                  onClick={props.onOpenLearning}
                  aria-label="学习与偏好"
                  title="学习与偏好"
                  aria-pressed={Boolean(props.learningOpen)}
                >
                  <Sparkles size={18} strokeWidth={1.7} />
                </button>
              )}
              {props.onOpenRemote && (
                <button
                  type="button"
                  className={`left-rail__dock-btn${props.remoteOpen ? ' left-rail__dock-btn--active' : ''}`}
                  onClick={props.onOpenRemote}
                  aria-label="远程连接"
                  title={props.remoteRunning ? '远程连接（运行中）' : '远程连接'}
                  aria-pressed={Boolean(props.remoteOpen)}
                >
                  <RadioTower size={18} strokeWidth={1.7} />
                  {props.remoteRunning && <span className="left-rail__online" title="远程服务运行中" />}
                </button>
              )}
              {showLearningOrRemote && showSettingsOrProfile && (
                <span className="left-rail__dock-sep" aria-hidden="true" />
              )}
              {props.onOpenSettings && (
                <button
                  type="button"
                  className={`left-rail__dock-btn${props.settingsOpen ? ' left-rail__dock-btn--active' : ''}`}
                  onClick={() => {
                    profile.close();
                    props.onOpenSettings?.();
                  }}
                  aria-label="设置"
                  title={mac ? `设置 ${formatShortcut(['Mod', ','])}` : '设置'}
                  aria-pressed={Boolean(props.settingsOpen)}
                >
                  <Settings2 size={18} strokeWidth={1.7} />
                </button>
              )}
              {showSettingsOrProfile && (
                <div className="left-rail__profile-wrap" ref={profileRowRef}>
                  <button
                    type="button"
                    className={`left-rail__profile${profileOpen ? ' left-rail__profile--open' : ''}`}
                    onClick={() => {
                      if (profile.step === 'closed' && props.account?.phase === 'ready') void props.account.refresh();
                      profile.toggle();
                    }}
                    aria-expanded={profileOpen}
                    aria-label={props.account ? '账号与个人资料' : '用户资料'}
                    aria-haspopup="dialog"
                    title={
                      props.account?.account?.loggedIn
                        ? `${profile.profile.nickname} (${props.account.account.username})`
                        : profile.profile.nickname || '个人资料与账号'
                    }
                  >
                    <ProfileAvatarView
                      className="left-rail__avatar"
                      avatar={profile.profile.avatar}
                      avatarUrl={profile.profile.avatarUrl}
                      size={28}
                    />
                    {props.account?.account?.loggedIn && (
                      <span className="left-rail__avatar-online" aria-hidden="true" />
                    )}
                  </button>
                </div>
              )}
            </div>
          )}
        </nav>

        <div className="left-rail__pane">
          {currentPane === 'activity' ? (
            <LeftRailActivityPane
              items={props.activityItems ?? []}
              onSelectItem={() => selectPane('projects')}
              onNewSession={() => {
                selectPane('projects');
                props.onNewSession();
              }}
            />
          ) : currentPane === 'tools' ? (
            <LeftRailToolsPane
              toolPlatform={props.toolPlatform}
              learningPort={props.learningPort}
              skillLearningRuntime={props.skillLearningRuntime}
              workBrowserDebug={props.workBrowserDebug}
              workCad={props.workCad}
              onOpenToolsSettings={props.onOpenToolsSettings ?? props.onOpenTools}
              onOpenLearningPending={props.onOpenLearning}
            />
          ) : (
            <>
          <div className="left-rail__pane-header">
            <span className="left-rail__pane-title">工作区</span>
            <div className="left-rail__pane-actions">
              <button
                type="button"
                className={`left-rail__pane-icon-btn${filterOpen || categoryFilter !== 'all' ? ' left-rail__pane-icon-btn--active' : ''}`}
                onClick={() => setFilterOpen((v) => !v)}
                aria-label="筛选分类"
                title="按分类筛选"
                aria-pressed={filterOpen || categoryFilter !== 'all'}
              >
                <ListFilter size={15} strokeWidth={1.75} aria-hidden="true" />
                {categoryFilter !== 'all' && <span className="left-rail__pane-action-dot" aria-hidden="true" />}
              </button>
              <button
                type="button"
                className={`left-rail__pane-icon-btn${searchOpen ? ' left-rail__pane-icon-btn--active' : ''}`}
                onClick={() => {
                  setSearchOpen((open) => {
                    if (open) setSearchQuery('');
                    return !open;
                  });
                }}
                aria-label="搜索项目与任务"
                title="搜索项目与任务"
                aria-pressed={searchOpen}
              >
                <Search size={15} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          </div>

          {(filterOpen || categoryFilter !== 'all') && (
            <div className="left-rail__filters" role="group" aria-label="任务分类">
              {(['all', 'code', 'work'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`left-rail__filter-pill${categoryFilter === kind ? ' left-rail__filter-pill--active' : ''}`}
                  aria-pressed={categoryFilter === kind}
                  onClick={() => setCategoryFilter(kind)}
                >
                  {kind === 'all' ? '全部' : kind === 'code' ? 'Code' : 'Work'}
                </button>
              ))}
              {(props.runningSessionIds.size > 0 || categoryFilter === 'running') && (
                <button
                  type="button"
                  className={`left-rail__filter-pill${categoryFilter === 'running' ? ' left-rail__filter-pill--active' : ''}`}
                  aria-pressed={categoryFilter === 'running'}
                  onClick={() => setCategoryFilter('running')}
                >
                  运行中
                </button>
              )}
            </div>
          )}

          {searchOpen && (
            <div className="left-rail__search">
              <Search size={13} className="left-rail__search-icon" aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="search"
                className="left-rail__search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setSearchQuery('');
                    setSearchOpen(false);
                  }
                }}
                placeholder="搜索项目或任务…"
                aria-label="搜索项目或任务"
                spellCheck={false}
              />
              {searchQuery.length > 0 && (
                <button
                  type="button"
                  className="left-rail__search-clear"
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                  aria-label="清空搜索"
                  title="清空搜索"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          <div className="left-rail__navigation">
            <button
              type="button"
              className="left-rail__nav left-rail__new"
              onClick={props.onNewSession}
              title={mac ? `新任务 ${formatShortcut(['Mod', 'N'])}` : undefined}
            >
              <SquarePen size={15} strokeWidth={1.75} />
              <span>新任务</span>
            </button>
          </div>

          <section className="left-rail__section left-rail__section--workspaces" aria-label="Workspaces">
            {pinnedSessions.length > 0 && (
              <div className="left-rail__pinned-group">
                <div className="left-rail__section-title">
                  <button
                    type="button"
                    className="left-rail__group-toggle"
                    aria-expanded={pinnedOpen}
                    onClick={() => setPinnedOpen((v) => !v)}
                  >
                    <span>置顶</span>
                    {pinnedOpen
                      ? <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
                      : <ChevronRight size={13} strokeWidth={1.8} aria-hidden="true" />}
                  </button>
                  <span className="left-rail__section-count" aria-label={`${pinnedSessions.length} 项置顶`}>
                    {pinnedSessions.length}
                  </span>
                </div>
                {pinnedOpen && (
                  <ul className="left-rail__sessions left-rail__sessions--pinned" role="list">
                    {pinnedSessions.map((s) => renderSessionRow(s, true))}
                  </ul>
                )}
              </div>
            )}

            <div className="left-rail__section-title">
              <button
                type="button"
                className="left-rail__group-toggle"
                aria-expanded={projectsOpen}
                onClick={() => setProjectsOpen((v) => !v)}
              >
                <span>项目</span>
                {projectsOpen
                  ? <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
                  : <ChevronRight size={13} strokeWidth={1.8} aria-hidden="true" />}
              </button>
              <button
                type="button"
                className="left-rail__project-add"
                onClick={props.onOpenFolder}
                aria-label="打开项目"
                title={mac ? `打开项目 ${formatShortcut(['Mod', 'O'])}` : '打开项目'}
              >
                <Plus size={15} />
              </button>
            </div>

            {projectsOpen && (
              filteredWorkspaces.length === 0 ? (
                <div className="left-rail__empty left-rail__empty--filtered">
                  <span>没有匹配的项目或对话</span>
                  <button type="button" className="left-rail__clear-filter" onClick={clearFilters}>
                    清除筛选
                  </button>
                </div>
              ) : (
                <ul className="left-rail__workspaces" role="list">
                  {filteredWorkspaces.map((ws) => {
                    const active = ws.id === props.currentWorkspaceId;
                    const expanded = expandedId === ws.id;
                    return (
                      <li
                        key={ws.id}
                        role="listitem"
                        className={`workspace-node${active ? ' workspace-node--active' : ''}`}
                      >
                        <div className="workspace-item" onContextMenu={(event) => onWorkspaceContextMenu(event, ws, active)}>
                          <button
                            type="button"
                            className="workspace-item__row"
                            onClick={() => toggleProject(ws.id)}
                            title={ws.root}
                            aria-current={active ? 'true' : undefined}
                            aria-expanded={expanded}
                          >
                            <span className="workspace-item__chev" aria-hidden="true">
                              {expanded
                                ? <ChevronDown size={12} strokeWidth={2} />
                                : <ChevronRight size={12} strokeWidth={2} />}
                            </span>
                            <WorkspaceFolderIcon open={expanded} size={15} />
                            <span className="workspace-item__name">{ws.name}</span>
                          </button>
                          {active && (
                            <button
                              type="button"
                              className="workspace-item__new"
                              onClick={(e) => {
                                e.stopPropagation();
                                props.onNewSession();
                              }}
                              title="New session"
                              aria-label="New session"
                            >
                              +
                            </button>
                          )}
                          <button
                            type="button"
                            className="workspace-item__close"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onCloseWorkspace(ws.id);
                            }}
                            title={`Close ${ws.name}`}
                            aria-label={`Close workspace ${ws.name}`}
                          >
                            <X size={12} strokeWidth={2.2} aria-hidden="true" />
                          </button>
                        </div>

                        {expanded && active && (
                          <div className="workspace-node__children">
                            {unpinnedSessions.length === 0 ? (
                              liveSessions.length === 0 ? (
                                <div className="left-rail__empty">还没有对话</div>
                              ) : pinnedSessions.length === 0 ? (
                                <div className="left-rail__empty left-rail__empty--filtered">
                                  <span>没有匹配的对话</span>
                                  <button type="button" className="left-rail__clear-filter" onClick={clearFilters}>
                                    清除筛选
                                  </button>
                                </div>
                              ) : null
                            ) : (
                              <ul className="left-rail__sessions" role="list">
                                {unpinnedSessions.map((s) => renderSessionRow(s, false))}
                              </ul>
                            )}

                            {hasArchived && (
                              <div className="archived-section">
                                <button
                                  type="button"
                                  className="archived-section__toggle"
                                  aria-expanded={archiveOpen}
                                  aria-controls={`archived-section-${props.currentWorkspaceId}`}
                                  onClick={() => setArchiveOpen((v) => !v)}
                                >
                                  <span className="archived-section__chev" aria-hidden="true">
                                    {archiveOpen
                                      ? <ChevronDown size={11} strokeWidth={2.2} />
                                      : <ChevronRight size={11} strokeWidth={2.2} />}
                                  </span>
                                  <Archive size={11} strokeWidth={2.2} aria-hidden="true" />
                                  <span>已归档</span>
                                  <span className="archived-section__count" aria-label={`${filteredArchivedSessions.length} 项已归档`}>
                                    {filteredArchivedSessions.length}
                                  </span>
                                </button>
                                {archiveOpen && (
                                  <ul
                                    id={`archived-section-${props.currentWorkspaceId}`}
                                    className="left-rail__sessions left-rail__sessions--archived"
                                    role="list"
                                  >
                                    {filteredArchivedSessions.map((s) => (
                                      <SessionRow
                                        key={s.id}
                                        session={s}
                                        isActive={false}
                                        isRunning={false}
                                        teamMark={null}
                                        isEditing={false}
                                        hoverSessionId={hoverSessionId}
                                        setHoverSessionId={setHoverSessionId}
                                        onSelect={props.onSelectSession}
                                        onDelete={requestDeleteSession}
                                        onArchive={handleArchiveSession}
                                        onStartEdit={() => undefined}
                                        onCommitEdit={() => undefined}
                                        onCancelEdit={() => undefined}
                                        archived
                                        onUnarchive={props.onUnarchiveSession}
                                      />
                                    ))}
                                  </ul>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )
            )}
          </section>
            </>
          )}
        </div>
      </div>

      {profile.step !== 'closed' && (props.onOpenSettings || props.account) && (
        <ProfileCard
          account={props.account}
          remoteActive={props.accountRemoteActive}
          step={profile.step}
          profile={profile.profile}
          draft={profile.draft}
          notice={profile.notice}
          picking={profile.picking}
          anchorRef={profileRowRef}
          onClose={profile.close}
          onOpenSettings={() => {
            profile.close();
            props.onOpenSettings?.();
          }}
          onCommitNickname={profile.commitNickname}
          onCommitBio={profile.commitBio}
          onStartAvatarEdit={profile.startAvatarEdit}
          onBackToCard={profile.backToCard}
          onPickImage={() => void profile.pickImage()}
          onPickPreset={profile.pickPreset}
          onConfirmAvatar={profile.confirmAvatar}
          onCancelAvatar={profile.cancelAvatar}
        />
      )}
      <ConfirmDialog
        open={pendingDeleteSession !== null}
        tone="danger"
        title="永久删除对话？"
        description={
          pendingDeleteSession
            ? `将永久删除「${pendingDeleteSession.title}」，删除后无法恢复。`
            : ''
        }
        confirmLabel="永久删除"
        cancelLabel="取消"
        onCancel={() => setPendingDeleteSession(null)}
        onConfirm={() => {
          if (pendingDeleteSession) props.onDeleteSession(pendingDeleteSession.id);
          setPendingDeleteSession(null);
        }}
      />
    </aside>
  );
}

