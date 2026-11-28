import { useEffect, useRef, useState, type ReactElement, type MouseEvent as ReactMouseEvent } from 'react';
import { Archive, ArchiveRestore, PanelsTopLeft, Code2, Pencil, Pin, PinOff, X } from 'lucide-react';
import type { ConversationSession } from '../../host-adapter/conversation-history';
import { showNativeContextMenu } from '../../host-adapter/native-shell';
import { isTauri } from '../../host-adapter/tauri-detect';
import { isImeComposing, isMacPlatform } from '../../utils/platform';

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
  readonly isPinned?: boolean;
  readonly onTogglePin?: (id: string) => void;
}

export function SessionRow(props: SessionRowProps): ReactElement {
  const { session: s } = props;
  const KindIcon = s.kind === 'code' ? Code2 : PanelsTopLeft;

  const onRowClick = (): void => {
    if (props.isEditing) return;
    props.onSelect(s.id);
  };

  const onDoubleClickTitle = (e: ReactMouseEvent): void => {
    if (props.archived) return;
    e.stopPropagation();
    props.onStartEdit(s.id);
  };

  const onRowContextMenu = (e: ReactMouseEvent): void => {
    if (!isMacPlatform() || !isTauri() || props.isEditing) return;
    e.preventDefault();
    e.stopPropagation();

    const items = props.archived
      ? [
          {
            id: 'unarchive',
            label: '从归档恢复',
            enabled: Boolean(props.onUnarchive) && !props.isRunning,
          },
          { id: 'sep-1', label: '', separator: true },
          { id: 'delete', label: '删除', enabled: !props.isRunning },
        ]
      : [
          ...(props.onTogglePin
            ? [{ id: 'pin', label: props.isPinned ? '取消置顶' : '置顶', enabled: !props.isRunning }]
            : []),
          { id: 'rename', label: '重命名', enabled: !props.isRunning },
          { id: 'archive', label: '归档', enabled: !props.isRunning },
          { id: 'sep-1', label: '', separator: true },
          { id: 'delete', label: '删除', enabled: !props.isRunning },
        ];

    void showNativeContextMenu(items).then((choice) => {
      if (choice === 'pin') props.onTogglePin?.(s.id);
      else if (choice === 'rename') props.onStartEdit(s.id);
      else if (choice === 'archive') props.onArchive(s.id);
      else if (choice === 'unarchive') props.onUnarchive?.(s.id);
      else if (choice === 'delete') props.onDelete(s.id);
    });
  };

  return (
    <li
      role="listitem"
      className={
        `session-row${props.isActive ? ' session-row--active' : ''}`
        + `${props.archived ? ' session-row--archived' : ''}`
      }
      onClick={onRowClick}
      onContextMenu={onRowContextMenu}
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
        <span className="session-row__running" role="status" aria-label="任务运行中" title="任务运行中">
          <span className="spinner spinner--xs" aria-hidden="true" />
          <span className="session-row__running-label" aria-hidden="true">运行中</span>
        </span>
      )}
      {/* Action cluster — mounted whenever idle so keyboard Tab and touch users
         can reach Rename / Archive / Restore / Delete without relying on hover. */}
      {!props.isRunning && !props.isEditing && (
        <span className="session-row__actions">
          {props.archived && props.onUnarchive ? (
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
            !props.archived && (
              <>
                {props.onTogglePin && (
                  <button
                    type="button"
                    className={`session-row__action session-row__action--pin${props.isPinned ? ' session-row__action--pinned' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onTogglePin!(s.id);
                    }}
                    title={props.isPinned ? '取消置顶' : '置顶'}
                    aria-label={`${props.isPinned ? 'Unpin' : 'Pin'} ${s.title}`}
                  >
                    {props.isPinned ? (
                      <PinOff size={11} strokeWidth={2.2} aria-hidden="true" />
                    ) : (
                      <Pin size={11} strokeWidth={2.2} aria-hidden="true" />
                    )}
                  </button>
                )}
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
            )
          )}
        </span>
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
        if (e.key === 'Enter' && !isImeComposing(e)) {
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
