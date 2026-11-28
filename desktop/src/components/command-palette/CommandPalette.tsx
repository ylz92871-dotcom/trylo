import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Command, FileText, LoaderCircle, Search, Sparkles } from 'lucide-react';
import { formatShortcut, isImeComposing } from '../../utils/platform';
import { prefersReducedMotion, usePresenceTransition } from '../../utils/use-presence-transition';
import {
  matchesPaletteQuery,
  type CommandAvailability,
  type CommandExecutionOrigin,
  type CommandOption,
  type CommandStep,
  type PaletteCommand,
  type PaletteGroup,
} from './command-registry';
import { listWorkspaceFiles, type WorkspaceFileEntry } from './workspace-file-index';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly commands: readonly PaletteCommand[];
  readonly workspaceRoot?: string;
  readonly previewFiles?: readonly { readonly path: string; readonly name?: string }[];
  readonly onOpenFile?: (path: string) => void;
}

interface RenderEntry {
  readonly id: string;
  readonly group: PaletteGroup;
  readonly label: string;
  readonly description?: string;
  readonly badge?: string;
  readonly active?: boolean;
  readonly shortcut?: readonly string[];
  readonly availability: CommandAvailability;
  readonly kind: 'file' | 'command' | 'option';
  readonly command?: PaletteCommand;
  readonly option?: CommandOption;
}

const GROUP_LABEL: Readonly<Record<PaletteGroup, string>> = {
  content: '内容与文件',
  action: '可执行动作',
};

export function CommandPalette(props: CommandPaletteProps): ReactElement | null {
  const { open, onClose, commands, workspaceRoot, previewFiles, onOpenFile } = props;
  const presence = usePresenceTransition(open, 130);
  const listId = useId();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const composingRef = useRef(false);
  const justCommittedRef = useRef(false);
  const querySeqRef = useRef(0);
  const navAppliedRef = useRef(false);

  const [rootQuery, setRootQuery] = useState('');
  const [stepQuery, setStepQuery] = useState('');
  const [stepSource, setStepSource] = useState<{ readonly command: PaletteCommand; readonly step: CommandStep } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [fileIndex, setFileIndex] = useState<{ root: string; files: readonly WorkspaceFileEntry[] }>();
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState('');

  // Reset transient query & step state when opening or closing cleanly.
  useEffect(() => {
    if (!open) {
      composingRef.current = false;
      justCommittedRef.current = false;
      setSubmitting(false);
      setError('');
      return;
    }

    navAppliedRef.current = false;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRootQuery('');
    setStepQuery('');
    setStepSource(null);
    setError('');
    setSubmitting(false);
    inputRef.current?.focus();

    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      // If a command already shifted focus to a target surface (e.g. preview / settings), keep it there.
      if (!navAppliedRef.current && opener?.isConnected) opener.focus();
    };
  }, [open]);

  // Async workspace file search with sequence isolation so stale scans never overwrite newer queries.
  useEffect(() => {
    if (!open || !workspaceRoot || stepSource) return undefined;
    const seq = ++querySeqRef.current;
    const controller = new AbortController();
    setFilesLoading(true);
    setFilesError('');

    listWorkspaceFiles(workspaceRoot, { signal: controller.signal })
      .then((loaded) => {
        if (seq !== querySeqRef.current || controller.signal.aborted) return;
        setFileIndex({ root: workspaceRoot, files: loaded });
        setFilesLoading(false);
      })
      .catch((err: unknown) => {
        if (seq !== querySeqRef.current || controller.signal.aborted) return;
        setFileIndex(undefined);
        setFilesError(err instanceof Error ? err.message : '读取工作区文件失败');
        setFilesLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [open, workspaceRoot, stepSource]);

  const query = stepSource ? stepQuery : rootQuery;

  const entries = useMemo<readonly RenderEntry[]>(() => {
    if (stepSource) {
      return stepSource.step.items
        .filter((option) =>
          matchesPaletteQuery(stepQuery, [option.label, option.description, ...(option.keywords ?? [])]),
        )
        .map((option) => ({
          id: option.id,
          group: 'action' as const,
          label: option.label,
          description: option.description,
          badge: option.badge,
          active: option.active,
          availability: option.availability ? option.availability() : { enabled: true },
          kind: 'option' as const,
          option,
        }));
    }

    const commandEntries: RenderEntry[] = commands
      .filter((cmd) => matchesPaletteQuery(rootQuery, [cmd.label, cmd.description, cmd.badge, ...cmd.keywords]))
      .map((cmd) => ({
        id: cmd.id,
        group: cmd.group,
        label: cmd.label,
        description: cmd.description,
        badge: cmd.badge,
        shortcut: cmd.shortcut,
        availability: cmd.availability(),
        kind: 'command' as const,
        command: cmd,
      }));

    if (!onOpenFile) return commandEntries;

    const mergedFiles = new Map<string, WorkspaceFileEntry>();
    for (const pf of previewFiles ?? []) {
      const normalized = pf.path.replace(/\\/g, '/');
      const name = pf.name ?? normalized.split('/').pop() ?? pf.path;
      mergedFiles.set(normalized, { path: pf.path, relativePath: name, name });
    }
    for (const wf of (fileIndex?.root === workspaceRoot ? fileIndex?.files ?? [] : [])) {
      mergedFiles.set(wf.path.replace(/\\/g, '/'), wf);
    }

    const fileEntries: RenderEntry[] = [...mergedFiles.values()]
      .filter((file) => matchesPaletteQuery(rootQuery, [file.name, file.relativePath]))
      .slice(0, rootQuery.trim() ? 12 : 5)
      .map((file) => ({
        id: `file:${file.path}`,
        group: 'content' as const,
        label: file.name,
        description: file.relativePath !== file.name ? file.relativePath : undefined,
        badge: '文件',
        availability: { enabled: true },
        kind: 'file' as const,
      }));

    const contentItems = [
      ...commandEntries.filter((entry) => entry.group === 'content'),
      ...fileEntries,
    ];
    const actionItems = commandEntries.filter((entry) => entry.group === 'action');
    return [...contentItems, ...actionItems];
  }, [stepSource, stepQuery, commands, rootQuery, onOpenFile, previewFiles, fileIndex, workspaceRoot]);

  // Keep active highlight valid when results change; never hold a stale/disappeared item.
  useEffect(() => {
    if (entries.length === 0) {
      setActiveId(null);
      return;
    }
    setActiveId((current) => {
      if (current && entries.some((entry) => entry.id === current)) return current;
      const firstEnabled = entries.find((entry) => entry.availability.enabled);
      return firstEnabled?.id ?? entries[0]!.id;
    });
  }, [entries]);

  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const activeNode = listRef.current.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(activeId)}"]`);
    activeNode?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  // Smooth Size Morph height adjustment on step/result transitions when motion is enabled.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list || prefersReducedMotion() || typeof list.animate !== 'function') return;
    const prevHeight = Number(list.dataset.prevHeight ?? '0');
    const nextHeight = list.getBoundingClientRect().height;
    list.dataset.prevHeight = String(nextHeight);
    if (prevHeight > 0 && Math.abs(prevHeight - nextHeight) >= 6) {
      list.animate(
        [{ height: `${prevHeight}px` }, { height: `${nextHeight}px` }],
        { duration: 150, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      );
    }
  }, [open, entries.length, stepSource]);

  const originForEntry = (element?: HTMLElement | null): CommandExecutionOrigin | undefined => {
    const target = element ?? dialogRef.current;
    if (!target) return undefined;
    const rect = target.getBoundingClientRect();
    if (!rect.width && !rect.height) return undefined;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };

  const executeEntry = async (entry: RenderEntry, element?: HTMLElement | null): Promise<void> => {
    if (submitting) return;
    setError('');

    if (entry.kind === 'file') {
      const filePath = entry.id.slice('file:'.length);
      navAppliedRef.current = true;
      onOpenFile?.(filePath);
      onClose();
      return;
    }

    if (entry.kind === 'command' && entry.command) {
      const freshAvailability = entry.command.availability();
      if (!freshAvailability.enabled) {
        setError(freshAvailability.reason || '当前条件下无法执行此操作');
        return;
      }
      if (entry.command.getStep) {
        const nextStep = entry.command.getStep();
        setStepSource({ command: entry.command, step: nextStep });
        setStepQuery('');
        setError('');
        inputRef.current?.focus();
        return;
      }
      if (!entry.command.run) return;
      setSubmitting(true);
      try {
        await entry.command.run(originForEntry(element));
        navAppliedRef.current = true;
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : '执行失败，请重试');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (entry.kind === 'option' && entry.option && stepSource) {
      const parentAvail = stepSource.command.availability();
      if (!parentAvail.enabled) {
        setError(parentAvail.reason || '当前上下文已变化，操作已取消');
        return;
      }
      const optionAvail = entry.option.availability ? entry.option.availability() : { enabled: true };
      if (!optionAvail.enabled) {
        setError(optionAvail.reason || '当前选项不可用');
        return;
      }
      setSubmitting(true);
      try {
        await entry.option.run(originForEntry(element));
        navAppliedRef.current = true;
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : '执行失败，请重试');
      } finally {
        setSubmitting(false);
      }
    }
  };

  const handleBackStep = (): void => {
    setStepSource(null);
    setStepQuery('');
    setError('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      const root = dialogRef.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (stepSource) handleBackStep();
      else onClose();
      return;
    }

    const imeBusy = composingRef.current || isImeComposing(event);
    if (imeBusy) return;

    if (justCommittedRef.current) {
      if (event.key === 'Enter') {
        justCommittedRef.current = false;
        return;
      }
      justCommittedRef.current = false;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (entries.length === 0) return;
      event.preventDefault();
      const idx = activeId ? entries.findIndex((entry) => entry.id === activeId) : -1;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = idx < 0 ? (delta > 0 ? 0 : entries.length - 1) : (idx + delta + entries.length) % entries.length;
      setActiveId(entries[nextIndex]!.id);
      return;
    }

    if (event.key === 'Home' && entries.length > 0 && document.activeElement !== inputRef.current) {
      event.preventDefault();
      setActiveId(entries[0]!.id);
      return;
    }

    if (event.key === 'End' && entries.length > 0 && document.activeElement !== inputRef.current) {
      event.preventDefault();
      setActiveId(entries[entries.length - 1]!.id);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const target = entries.find((entry) => entry.id === activeId);
      if (!target) return;
      const domNode = listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(target.id)}"]`);
      void executeEntry(target, domNode);
    }
  };

  if (!presence.mounted || typeof document === 'undefined') return null;

  const isExiting = presence.state === 'exiting';
  const contentEntries = entries.filter((entry) => entry.group === 'content');
  const actionEntries = entries.filter((entry) => entry.group === 'action');
  const groups: readonly { readonly key: PaletteGroup; readonly items: readonly RenderEntry[] }[] = stepSource
    ? [{ key: 'action', items: entries }]
    : [
        ...(contentEntries.length > 0 ? [{ key: 'content' as const, items: contentEntries }] : []),
        ...(actionEntries.length > 0 ? [{ key: 'action' as const, items: actionEntries }] : []),
      ];

  return createPortal(
    <div
      className="command-palette__backdrop"
      data-motion-state={presence.state}
      aria-hidden={isExiting ? true : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="command-palette"
        role={isExiting ? undefined : 'dialog'}
        aria-modal={isExiting ? undefined : 'true'}
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <div className="command-palette__header">
          {stepSource ? (
            <button
              type="button"
              className="command-palette__back"
              onClick={handleBackStep}
              aria-label="返回上一级命令"
              title="返回"
            >
              <ArrowLeft size={15} aria-hidden="true" />
            </button>
          ) : (
            <span className="command-palette__search-icon" aria-hidden="true">
              <Search size={15} strokeWidth={1.8} />
            </span>
          )}
          <div className="command-palette__input-wrap">
            {stepSource && (
              <span id={titleId} className="command-palette__step-title">
                {stepSource.step.title}
              </span>
            )}
            {!stepSource && (
              <span id={titleId} className="sr-only">
                全局命令面板
              </span>
            )}
            <input
              ref={inputRef}
              type="text"
              className="command-palette__input"
              role="combobox"
              aria-labelledby={titleId}
              aria-autocomplete="list"
              aria-expanded={true}
              aria-controls={listId}
              aria-activedescendant={activeId ? `${listId}-${activeId}` : undefined}
              placeholder={stepSource ? stepSource.step.placeholder : '搜索文件、会话或输入命令…'}
              value={query}
              disabled={submitting}
              onChange={(event) => {
                setError('');
                if (stepSource) setStepQuery(event.target.value);
                else setRootQuery(event.target.value);
              }}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
                justCommittedRef.current = true;
                window.setTimeout(() => {
                  justCommittedRef.current = false;
                }, 0);
              }}
            />
          </div>
          {filesLoading && !stepSource && (
            <span className="command-palette__loading" role="status" aria-label="正在索引工作区文件">
              <LoaderCircle size={14} className="command-palette__spinner" aria-hidden="true" />
            </span>
          )}
          <kbd className="command-palette__esc">Esc</kbd>
        </div>

        {error && (
          <div className="command-palette__error" role="alert">
            {error}
          </div>
        )}

        {filesError && !stepSource && (
          <div className="command-palette__notice" role="status">
            文件索引暂不可用：{filesError}
          </div>
        )}

        <div ref={listRef} id={listId} className="command-palette__list" role="listbox" aria-label="命令与内容列表">
          {entries.length === 0 ? (
            <div className="command-palette__empty">
              {filesLoading && !stepSource ? '正在检索工作区…' : '没有匹配的命令或文件'}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.key} className="command-palette__group">
                {!stepSource && <div className="command-palette__group-title">{GROUP_LABEL[group.key]}</div>}
                {group.items.map((entry) => {
                  const selected = entry.id === activeId;
                  const disabled = !entry.availability.enabled;
                  return (
                    <button
                      key={entry.id}
                      id={`${listId}-${entry.id}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-disabled={disabled}
                      data-entry-id={entry.id}
                      className={`command-palette__item${selected ? ' command-palette__item--active' : ''}${disabled ? ' command-palette__item--disabled' : ''}`}
                      onMouseMove={() => {
                        if (activeId !== entry.id) setActiveId(entry.id);
                      }}
                      onClick={(event) => void executeEntry(entry, event.currentTarget)}
                    >
                      <span className="command-palette__item-icon" aria-hidden="true">
                        {entry.kind === 'file' ? (
                          <FileText size={14} />
                        ) : entry.active ? (
                          <Check size={14} />
                        ) : entry.group === 'action' ? (
                          <Sparkles size={14} />
                        ) : (
                          <Command size={14} />
                        )}
                      </span>
                      <span className="command-palette__item-main">
                        <span className="command-palette__item-label">{entry.label}</span>
                        {(disabled && entry.availability.reason ? entry.availability.reason : entry.description) && (
                          <span className="command-palette__item-desc">
                            {disabled && entry.availability.reason ? entry.availability.reason : entry.description}
                          </span>
                        )}
                      </span>
                      {entry.badge && <span className="command-palette__badge">{entry.badge}</span>}
                      {entry.shortcut && (
                        <kbd className="command-palette__shortcut">{formatShortcut(entry.shortcut)}</kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <footer className="command-palette__footer">
          <span>↑↓ 移动</span>
          <span>↵ 确认</span>
          <span>{stepSource ? 'Esc 返回上一步' : 'Esc 关闭'}</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
