import { Logo } from '../brand/Logo';
import { SessionRow } from './SessionRow';
import { ProfileCard, ProfileAvatarView } from './ProfileCard';
import { SquarePen, PanelLeft, Layers2, Blocks, Sparkles, RadioTower, Settings2, Folder, FolderPlus } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  Archive,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { ConversationSession } from '../../host-adapter/conversation-history';
import { useUserProfile } from '../../user-profile/use-user-profile';
import type { DesktopAccountModel } from '../../account/desktop-account';

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
  readonly onOpenActivity?: () => void;
  readonly activeRuns?: number;
  readonly onOpenTools?: () => void;
  readonly onOpenLearning?: () => void;
  readonly onOpenRemote?: () => void;
  readonly remoteRunning?: boolean;
  readonly onOpenSettings?: () => void;
  readonly account?: DesktopAccountModel;
  readonly accountOpenRequest?: number;
  readonly accountRemoteActive?: boolean;
}

export function LeftRail(props: LeftRailProps): ReactElement | null {
  const [hoverSessionId, setHoverSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  // 2026-09-06: the Archived disclosure lives per-active-workspace but
  // is closed by default — the user opens it the first time they need
  // to recover something. Persisted across re-renders but not across
  // workspace switches (the closest sane per-project choice would be a
  // Set<workspaceId> stored on the workspace index; not worth it now).
  const [archiveOpen, setArchiveOpen] = useState(false);
  // User identity card (nickname / bio / avatar). Self-contained:
  // loads and saves through the profile store, no App plumbing.
  const profile = useUserProfile();
  // The ProfileCard is portalled to <body> and anchored to this
  // row's rect (it overflows the 210px rail by design).
  const profileRowRef = useRef<HTMLDivElement>(null);
  const openProfile = profile.open;
  useEffect(() => {
    if (props.accountOpenRequest) openProfile();
  }, [props.accountOpenRequest, openProfile]);

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
  }, [props.currentWorkspaceId]);

  if (props.collapsed) return null;

  const toggleProject = (wsId: string): void => {
    if (expandedId === wsId) {
      // Clicking the already-open project collapses it.
      setExpandedId(null);
    } else {
      props.onSwitchWorkspace(wsId);
      setExpandedId(wsId);
    }
  };

  // Partition once per render so the JSX below stays readable.
  const liveSessions = props.sessions.filter((s) => !s.archivedAt);
  const archivedSessions = props.sessions.filter((s) => !!s.archivedAt);
  const hasArchived = archivedSessions.length > 0;

  return (
    <aside
      className="left-rail"
      aria-label="Workspaces and sessions"
      style={{ position: 'relative' }}
    >
      <div className="left-rail__header">
        <div className="left-rail__brand"><Logo size={40} tone="cream" variant="solid" withBg decorative /><span>Trylo</span></div>
        <button type="button" className="left-rail__collapse" onClick={props.onToggleCollapse} title="收起侧栏" aria-label="Collapse rail"><PanelLeft size={16} /></button>
      </div>
      <nav className="left-rail__navigation" aria-label="任务导航">
        <button type="button" className="left-rail__nav left-rail__new" onClick={props.onNewSession}><SquarePen size={16} /><span>新任务</span></button>
        {props.onOpenActivity && <button type="button" className="left-rail__nav" onClick={props.onOpenActivity}><Layers2 size={16} /><span>后台任务</span>{(props.activeRuns ?? 0) > 0 && <span className="left-rail__count">{props.activeRuns}</span>}</button>}
        {props.onOpenTools && <button type="button" className="left-rail__nav" onClick={props.onOpenTools}><Blocks size={16} /><span>工具与技能</span></button>}
      </nav>

      <section className="left-rail__section left-rail__section--workspaces" aria-label="Workspaces">
        <div className="left-rail__section-title">
          <span>项目</span>
          <button type="button" className="left-rail__project-add" onClick={props.onOpenFolder} aria-label="打开项目" title="打开项目"><Plus size={16} /></button>
        </div>

        <ul className="left-rail__workspaces" role="list">
          {props.workspaces.map((ws) => {
            const active = ws.id === props.currentWorkspaceId;
            const expanded = expandedId === ws.id;
            return (
              <li
                key={ws.id}
                role="listitem"
                className={`workspace-node${active ? ' workspace-node--active' : ''}`}
              >
                <div className="workspace-item">
                  <button
                    type="button"
                    className="workspace-item__row"
                    onClick={() => toggleProject(ws.id)}
                    title={ws.root}
                    aria-current={active ? 'true' : undefined}
                    aria-expanded={expanded}
                  >
                    <span className="workspace-item__chev" aria-hidden="true">
                      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </span>
                    <Folder size={16} aria-hidden="true" />
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
                      {liveSessions.length === 0 ? (
                      <div className="left-rail__empty">还没有对话</div>
                    ) : (
                      <ul className="left-rail__sessions" role="list">
                        {liveSessions.map((s) => (
                          <SessionRow
                            key={s.id}
                            session={s}
                            isActive={s.id === props.activeSessionId}
                            isRunning={props.runningSessionIds.has(s.id)}
                            teamMark={props.teamMarks?.get(s.id) ?? null}
                            isEditing={editingSessionId === s.id}
                            hoverSessionId={hoverSessionId}
                            setHoverSessionId={setHoverSessionId}
                            onSelect={props.onSelectSession}
                            onDelete={props.onDeleteSession}
                            onArchive={props.onArchiveSession}
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
                        ))}
                      </ul>
                    )}

                    {/* Archived disclosure — collapsed by default. Hidden
                       entirely when the user has never archived anything
                       so the rail stays out of the way for fresh
                       workspaces. */}
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
                          <span>Archived</span>
                          <span className="archived-section__count" aria-label={`${archivedSessions.length} archived`}>
                            {archivedSessions.length}
                          </span>
                        </button>
                        {archiveOpen && (
                          <ul
                            id={`archived-section-${props.currentWorkspaceId}`}
                            className="left-rail__sessions left-rail__sessions--archived"
                            role="list"
                          >
                            {archivedSessions.map((s) => (
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
                                onDelete={props.onDeleteSession}
                                onArchive={props.onArchiveSession}
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

        <button
          type="button"
          className="left-rail__add-workspace"
          onClick={props.onOpenFolder}
          title="Open a folder as a new workspace"
        >
          <FolderPlus size={16} aria-hidden="true" />
          <span>打开项目</span>
        </button>
      </section>
      <nav className="left-rail__footer" aria-label="应用设置">
        {props.onOpenLearning && <button type="button" className="left-rail__nav" onClick={props.onOpenLearning}><Sparkles size={16} /><span>学习与偏好</span></button>}
        {props.onOpenRemote && <button type="button" className="left-rail__nav" onClick={props.onOpenRemote}><RadioTower size={16} /><span>远程连接</span>{props.remoteRunning && <span className="left-rail__online" title="远程服务运行中" />}</button>}
        {props.onOpenSettings && (
          <div className="left-rail__profile-wrap" ref={profileRowRef}>
            <button
              type="button"
              className={`left-rail__profile${profile.step !== 'closed' ? ' left-rail__profile--open' : ''}`}
              onClick={() => {
                if (profile.step === 'closed' && props.account?.phase === 'ready') void props.account.refresh();
                profile.toggle();
              }}
              aria-expanded={profile.step !== 'closed'}
              aria-label={props.account ? '账号与个人资料' : '用户资料'}
              aria-haspopup="dialog"
            >
              <ProfileAvatarView
                className="left-rail__avatar"
                avatar={profile.profile.avatar}
                avatarUrl={profile.profile.avatarUrl}
                size={28}
              />
              <span className="left-rail__profile-text">
                {props.account ? props.account.account?.loggedIn ? profile.profile.nickname : '本地工作区' : profile.step === 'closed' ? '本地工作区' : profile.profile.nickname}
                <small>{props.account ? props.account.account?.loggedIn ? props.account.account.username : props.account.phase === 'waiting' ? '等待登录确认' : props.account.phase === 'checking' ? '正在读取账号…' : '未登录' : profile.step === 'closed' ? '设置与连接' : '用户资料'}</small>
              </span>
            </button>
            <button
              type="button"
              className="left-rail__profile-gear"
              onClick={() => {
                profile.close();
                props.onOpenSettings?.();
              }}
              aria-label="设置"
              title="设置"
            >
              <Settings2 size={16} />
            </button>
          </div>
        )}
      </nav>
      {profile.step !== 'closed' && props.onOpenSettings && (
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
    </aside>
  );
}

