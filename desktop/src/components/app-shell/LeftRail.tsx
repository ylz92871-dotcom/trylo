// Trylo Desktop — LeftRail. v1.17 CodeBuddy-style layout.
//
// The left rail is a single, focused navigation column:
//
//   WORKSPACES            ← top level, the "总项目 / workspace"
//   ├── ● trylo           ← a workspace == a project folder
//   │      ▾ Sessions     ← history nested under the project,
//   │         💬 你好呀       collapsible (like CodeBuddy)
//   │         💬 你好
//   │         + New session
//   │      ▸ Archived (3)   ← collapsible; soft-deleted sessions
//   ├── ○ other-workspace
//   + Open folder
//
// The file tree is NO LONGER here — it lives in the toggleable
// right rail (RightRail.tsx). This frees the left rail to be a
// clean "project → conversation history" tree, the inverse of
// Cursor's file-first layout.
//
// 2026-09-06:
//   * Rename: double-click a session title (or the inline pencil icon on
//     hover) to edit it inline. Enter / blur saves, Escape cancels.
//   * Archive: hover-revealed archive icon (round-badge) soft-deletes the
//     row without losing its messages / attachments. Unarchive is one
//     click from the Archived disclosure.
//   * Kind badges are now lucide icons (Code2 / Briefcase) instead of
//     the rounded "C" / "W" tile, per the design note: "code/work 图标
//     还是太丑了".
//   * The active conversation list is now filtered — archived sessions
//     only show in the disclosure. Active / running / un-run counts are
//     preserved exactly.

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import {
  Archive,
  ArchiveRestore,
  Briefcase,
  Code2,
  Folders,
  Pencil,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { ConversationSession } from '../../host-adapter/conversation-history';

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
}

export function LeftRail(props: LeftRailProps): ReactElement {
  const [hoverSessionId, setHoverSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  // 2026-09-06: the Archived disclosure lives per-active-workspace but
  // is closed by default — the user opens it the first time they need
  // to recover something. Persisted across re-renders but not across
  // workspace switches (the closest sane per-project choice would be a
  // Set<workspaceId> stored on the workspace index; not worth it now).
  const [archiveOpen, setArchiveOpen] = useState(false);

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

  if (props.collapsed) {
    return (
      <aside
        className="left-rail left-rail--collapsed"
        aria-label="Workspaces and sessions"
      >
        <button
          type="button"
          className="left-rail__collapse"
          onClick={props.onToggleCollapse}
          title="Expand"
          aria-label="Expand rail"
        >
          ›
        </button>
      </aside>
    );
  }

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
    >
      <div className="left-rail__header">
        <button
          type="button"
          className="left-rail__collapse"
          onClick={props.onToggleCollapse}
          title="Collapse"
          aria-label="Collapse rail"
        >
          ‹
        </button>
      </div>

      <section className="left-rail__section left-rail__section--workspaces" aria-label="Workspaces">
        <div className="left-rail__section-title">
          <Folders size={12} strokeWidth={2.2} aria-hidden="true" />
          <span>Workspaces</span>
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
                    <span
                      className={`workspace-item__dot${active ? ' workspace-item__dot--active' : ''}`}
                      aria-hidden="true"
                    />
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
                      <div className="left-rail__empty">No sessions yet.</div>
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
          <Plus size={12} strokeWidth={2.2} aria-hidden="true" />
          <span>Open folder</span>
        </button>
      </section>
    </aside>
  );
}

// ── SessionRow ────────────────────────────────────────────────────────
// One row per session. Pulled out of the parent JSX so the rename-input
// state can live in the same component that handles hover, kind icons
// and the action cluster.

interface SessionRowProps {
  readonly session: ConversationSession;
  readonly isActive: boolean;
  readonly isRunning: boolean;
  /** 'active' = team run in progress; 'past' = had a team run; null = none. */
  readonly teamMark: 'active' | 'past' | null;
  /** Whether this row is currently being renamed inline. */
  readonly isEditing: boolean;
  readonly hoverSessionId: string | null;
  readonly setHoverSessionId: (id: string | null) => void;
  readonly onSelect: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onArchive: (id: string) => void;
  /** Begin editing this row's title. */
  readonly onStartEdit: (id: string) => void;
  /** Commit the new title. The hook host decides whether to keep it
   *  (trim, deduplicate, etc.). */
  readonly onCommitEdit: (id: string, title: string) => void;
  /** Abort the edit without writing. */
  readonly onCancelEdit: () => void;
  /** If true, swap the row's hover-actions for an Unarchive button. */
  readonly archived?: boolean;
  readonly onUnarchive?: (id: string) => void;
}

function SessionRow(props: SessionRowProps): ReactElement {
  const { session: s } = props;
  const hovered = props.hoverSessionId === s.id;
  const KindIcon = s.kind === 'code' ? Code2 : Briefcase;

  const onRowClick = (): void => {
    if (props.isEditing) return;
    props.onSelect(s.id);
  };

  const onDoubleClickTitle = (e: ReactMouseEvent): void => {
    if (props.archived) return;
    e.stopPropagation();
    props.onStartEdit(s.id);
  };

  return (
    <li
      role="listitem"
      className={
        `session-row${props.isActive ? ' session-row--active' : ''}`
        + `${props.archived ? ' session-row--archived' : ''}`
      }
      onClick={onRowClick}
      onMouseEnter={() => props.setHoverSessionId(s.id)}
      onMouseLeave={() => props.setHoverSessionId(null)}
      title={s.title}
      data-kind={s.kind}
      data-archived={props.archived ? 'true' : 'false'}
    >
      <span
        className={`session-row__kind session-row__kind--${s.kind}${props.archived ? ' session-row__kind--archived' : ''}`}
        aria-hidden="true"
      >
        <KindIcon size={11} strokeWidth={2.2} aria-hidden="true" />
      </span>
      {props.isEditing ? (
        <RenameInput
          initialTitle={s.title}
          onCommit={(title) => props.onCommitEdit(s.id, title)}
          onCancel={props.onCancelEdit}
        />
      ) : (
        <span
          className="session-row__title"
          onDoubleClick={onDoubleClickTitle}
        >
          {s.title}
        </span>
      )}
      {props.teamMark && !props.archived && (
        <span
          className={`session-row__team-mark${props.teamMark === 'active' ? ' session-row__team-mark--active' : ''}`}
          title={props.teamMark === 'active' ? '团队进行中' : '有团队历史'}
        >
          Team
        </span>
      )}
      {props.isRunning && (
        <span className="spinner spinner--xs" aria-hidden="true" />
      )}
      {/* Action cluster — hover-revealed. Archived rows expose the
         archive-restore button only; live rows show delete + archive. */}
      {hovered && !props.isRunning && (
        props.archived && props.onUnarchive ? (
          <button
            type="button"
            className="session-row__action session-row__action--unarchive"
            onClick={(e) => {
              e.stopPropagation();
              props.onUnarchive!(s.id);
            }}
            title="Restore from archive"
            aria-label={`Restore ${s.title}`}
          >
            <ArchiveRestore size={11} strokeWidth={2.2} aria-hidden="true" />
          </button>
        ) : (
          <>
            {!props.isEditing && !props.archived && (
              <>
                <button
                  type="button"
                  className="session-row__action session-row__action--rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onStartEdit(s.id);
                  }}
                  title="Rename"
                  aria-label={`Rename ${s.title}`}
                >
                  <Pencil size={11} strokeWidth={2.2} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="session-row__action session-row__action--archive"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onArchive(s.id);
                  }}
                  title="Archive"
                  aria-label={`Archive ${s.title}`}
                >
                  <Archive size={11} strokeWidth={2.2} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="session-row__action session-row__action--delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onDelete(s.id);
                  }}
                  title="Delete"
                  aria-label={`Delete ${s.title}`}
                >
                  <X size={11} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </>
            )}
          </>
        )
      )}
    </li>
  );
}

// ── RenameInput ───────────────────────────────────────────────────────
// A minimal inline editor. Enter saves, Escape cancels, blur saves.
// Lives separately so its input can autofocus + own a ref without the
// row re-rendering around it.
interface RenameInputProps {
  readonly initialTitle: string;
  readonly onCommit: (title: string) => void;
  readonly onCancel: () => void;
}

function RenameInput(props: RenameInputProps): ReactElement {
  const [value, setValue] = useState(props.initialTitle);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Focus + select-all on mount so the user can overtype immediately
    // (the common case) or paste over a substring (less common).
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const commit = (): void => {
    // Defer to the parent — it applies the trim / no-op-empty rules.
    // If the user typed nothing different we still bounce through
    // commit so the row returns to the same shape it had on entry.
    props.onCommit(value);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      className="session-row__rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          props.onCancel();
        }
      }}
      onBlur={commit}
      // Hitting Enter / Escape should NOT blur-then-commit-then-cancel.
      // preventDefault on KeyDown keeps the input focused, then the
      // parent's onCommit/onCancel removes the input from the tree so
      // the final blur never fires.
      aria-label="Session title"
      spellCheck={false}
    />
  );
}
