// Trylo Desktop — SearchPanel. See ARCHITECTURE.md §2.4 (Ctrl+Shift+F
// → ripgrep-backed search service override) + §3 Phase 0 Day 6 +
// Week 2 Day 2 (regex / case toggles + click-to-jump).
//
// Supports both standalone inline workspace search and a centered
// macOS Spotlight/Raycast command palette + workspace search modal.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { Search, FileText, Command } from 'lucide-react';
import { hostAdapter, type FilePath, type SearchMatch } from '../../host-adapter';
import { formatShortcut, isPrimaryModKey } from '../../utils/platform';
import { usePresenceTransition } from '../../utils/use-presence-transition';

export interface SearchPanelAction {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly shortcut?: readonly string[];
  readonly keywords?: string;
  readonly onSelect: () => void;
}

export interface SearchPanelProps {
  /** Search root — typically the workspace root. */
  readonly searchRoot: FilePath;
  /** Called when the user clicks a result row. The caller
   *  typically opens the file as a new tab. */
  readonly onResultOpen: (path: FilePath, line: number) => void;
  readonly modal?: boolean;
  readonly open?: boolean;
  readonly onClose?: () => void;
  readonly actions?: readonly SearchPanelAction[];
}

type ModalNavItem =
  | { readonly kind: 'action'; readonly key: string; readonly action: SearchPanelAction }
  | { readonly kind: 'search-trigger'; readonly key: string; readonly query: string }
  | { readonly kind: 'result'; readonly key: string; readonly match: SearchMatch };

export function SearchPanel({
  searchRoot,
  onResultOpen,
  modal = false,
  open = false,
  onClose,
  actions = [],
}: SearchPanelProps): ReactElement | null {
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const listboxId = useId();
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [caseInsensitive, setCaseInsensitive] = useState(false);
  const [results, setResults] = useState<readonly SearchMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // Ctrl+Shift+F / Cmd+Shift+F anywhere → focus the standalone search input.
  useEffect(() => {
    if (modal) return;
    const onKey = (e: KeyboardEvent): void => {
      if (isPrimaryModKey(e) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal]);

  // Modal lifecycle: reset transient query/results, focus input, restore previous focus.
  useEffect(() => {
    if (!modal || !open) return;
    const previousFocus = document.activeElement;
    setQuery('');
    setResults(null);
    setError(null);
    setSearching(false);
    setActiveIndex(0);
    inputRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [modal, open]);

  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLocaleLowerCase();

  const filteredActions = useMemo(() => {
    if (!modal) return [];
    if (!normalizedQuery) return actions;
    return actions.filter((action) =>
      `${action.label} ${action.hint ?? ''} ${action.keywords ?? ''} ${action.id}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [actions, modal, normalizedQuery]);

  const onSearch = useCallback(async (): Promise<void> => {
    const q = query.trim();
    if (q === '') {
      setResults(null);
      setError(null);
      return;
    }
    if (searchRoot.trim() === '') {
      setError('当前未打开工作区目录。');
      setResults(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const matches = await hostAdapter.search.search(q, searchRoot, {
        regex: useRegex,
        caseInsensitive,
      });
      setResults(matches);
      if (modal && matches.length > 0) {
        setActiveIndex(filteredActions.length);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setResults(null);
    } finally {
      setSearching(false);
    }
  }, [caseInsensitive, filteredActions.length, modal, query, searchRoot, useRegex]);

  const modalItems = useMemo<readonly ModalNavItem[]>(() => {
    if (!modal) return [];
    const items: ModalNavItem[] = filteredActions.map((action) => ({
      kind: 'action',
      key: `action:${action.id}`,
      action,
    }));
    if (results !== null) {
      results.forEach((match, index) => {
        items.push({
          kind: 'result',
          key: `result:${match.path}:${match.line}:${index}`,
          match,
        });
      });
    }
    if (trimmedQuery !== '' && searchRoot.trim() !== '') {
      items.push({
        kind: 'search-trigger',
        key: 'search-trigger',
        query: trimmedQuery,
      });
    }
    return items;
  }, [filteredActions, modal, results, searchRoot, trimmedQuery]);

  useEffect(() => {
    if (!modal) return;
    setActiveIndex((current) => Math.min(current, Math.max(0, modalItems.length - 1)));
  }, [modal, modalItems.length]);

  useEffect(() => {
    if (!modal || !open) return;
    const el = itemRefs.current[activeIndex];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, modal, open]);

  const modalPresence = usePresenceTransition(modal && open, 100);

  if (modal && !modalPresence.mounted) return null;

  const activateModalItem = (item: ModalNavItem): void => {
    if (item.kind === 'action') {
      item.action.onSelect();
      onCloseRef.current?.();
      return;
    }
    if (item.kind === 'result') {
      onResultOpen(item.match.path, item.match.line);
      return;
    }
    void onSearch();
  };

  const handleModalKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current?.();
      return;
    }
    if (e.key === 'ArrowDown') {
      if (modalItems.length === 0) return;
      e.preventDefault();
      setActiveIndex((current) => (current + 1) % modalItems.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      if (modalItems.length === 0) return;
      e.preventDefault();
      setActiveIndex((current) => (current - 1 + modalItems.length) % modalItems.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isPrimaryModKey(e)) {
        void onSearch();
        return;
      }
      const item = modalItems[activeIndex];
      if (item) {
        activateModalItem(item);
      } else if (trimmedQuery !== '') {
        void onSearch();
      }
    }
  };

  if (modal) {
    const isExiting = modalPresence.state === 'exiting';
    const activeItem = modalItems[activeIndex];
    const activeOptionId = activeItem ? `${listboxId}-opt-${activeIndex}` : undefined;
    itemRefs.current.length = modalItems.length;

    return (
      <div
        className="search-panel-backdrop"
        data-motion-state={modalPresence.state}
        aria-hidden={isExiting ? true : undefined}
        onClick={(e) => {
          if (!isExiting && e.target === e.currentTarget) onCloseRef.current?.();
        }}
      >
        <section
          className="search-panel search-panel--modal"
          role={isExiting ? undefined : 'dialog'}
          aria-modal={isExiting ? undefined : true}
          aria-label={isExiting ? undefined : '命令面板与工作区搜索'}
          onKeyDown={handleModalKeyDown}
        >
          <div className="search-panel-modal__input-row">
            <Search size={16} className="search-panel-modal__search-icon" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label="命令或工作区搜索"
              aria-expanded={modalItems.length > 0}
              aria-controls={listboxId}
              aria-activedescendant={activeOptionId}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setResults(null);
                setError(null);
                setActiveIndex(0);
              }}
              placeholder={`输入命令或搜索工作区 (${formatShortcut(['Mod', 'Shift', 'F'])})`}
              spellCheck={false}
            />
            <button
              type="button"
              className="search-panel-modal__search-btn"
              onClick={() => void onSearch()}
              disabled={searching || trimmedQuery === ''}
              aria-label="搜索工作区"
            >
              {searching ? '搜索中…' : '搜索文件'}
            </button>
          </div>

          <div className="search-panel-toggles search-panel-toggles--modal">
            <label>
              <input
                type="checkbox"
                checked={useRegex}
                onChange={(e) => setUseRegex(e.target.checked)}
              />
              regex
            </label>
            <label>
              <input
                type="checkbox"
                checked={caseInsensitive}
                onChange={(e) => setCaseInsensitive(e.target.checked)}
              />
              case-insensitive
            </label>
            <span className="search-panel-modal__nav-hint">
              ↑↓ 选择 · {formatShortcut(['Enter'])} 执行 · {formatShortcut(['Escape'])} 关闭
            </span>
          </div>

          {error && <div className="search-panel-error" role="alert">error: {error}</div>}
          {results !== null && !error && (
            <div className="search-panel-meta">
              {results.length === 0
                ? '工作区无匹配内容'
                : `${results.length} match${results.length === 1 ? '' : 'es'}`}
            </div>
          )}

          <ul id={listboxId} className="search-panel-results search-panel-results--modal" role="listbox" aria-label="命令与搜索结果">
            {modalItems.length === 0 ? (
              <li className="search-panel-modal__empty">没有匹配的命令或文件</li>
            ) : (
              modalItems.map((item, idx) => {
                const isActive = idx === activeIndex;
                const optionId = `${listboxId}-opt-${idx}`;
                if (item.kind === 'action') {
                  return (
                    <li
                      key={item.key}
                      id={optionId}
                      ref={(el) => { itemRefs.current[idx] = el; }}
                      role="option"
                      aria-selected={isActive}
                      className={`search-panel-modal__item${isActive ? ' search-panel-modal__item--active' : ''}`}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => activateModalItem(item)}
                    >
                      <Command size={14} className="search-panel-modal__item-icon" aria-hidden="true" />
                      <span className="search-panel-modal__item-text">
                        <span className="search-panel-modal__item-label">{item.action.label}</span>
                        {item.action.hint && (
                          <span className="search-panel-modal__item-hint">{item.action.hint}</span>
                        )}
                      </span>
                      {item.action.shortcut && item.action.shortcut.length > 0 && (
                        <kbd className="search-panel-modal__shortcut">
                          {formatShortcut(item.action.shortcut)}
                        </kbd>
                      )}
                    </li>
                  );
                }
                if (item.kind === 'search-trigger') {
                  return (
                    <li
                      key={item.key}
                      id={optionId}
                      ref={(el) => { itemRefs.current[idx] = el; }}
                      role="option"
                      aria-selected={isActive}
                      className={`search-panel-modal__item search-panel-modal__item--trigger${isActive ? ' search-panel-modal__item--active' : ''}`}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => activateModalItem(item)}
                    >
                      <Search size={14} className="search-panel-modal__item-icon" aria-hidden="true" />
                      <span className="search-panel-modal__item-text">
                        <span className="search-panel-modal__item-label">
                          在工作区中搜索 “{item.query}”
                        </span>
                      </span>
                      <kbd className="search-panel-modal__shortcut">{formatShortcut(['Mod', 'Enter'])}</kbd>
                    </li>
                  );
                }
                const m = item.match;
                return (
                  <li
                    key={item.key}
                    id={optionId}
                    ref={(el) => { itemRefs.current[idx] = el; }}
                    role="option"
                    aria-selected={isActive}
                    className={`search-panel-result search-panel-result--modal${isActive ? ' search-panel-modal__item--active' : ''}`}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => activateModalItem(item)}
                  >
                    <FileText size={14} className="search-panel-modal__item-icon" aria-hidden="true" />
                    <span className="search-panel-result__body">
                      <span className="search-panel-path">{m.path}:{m.line}</span>
                      <span className="search-panel-content">{m.content}</span>
                    </span>
                    <span className="search-panel-line">{m.line}</span>
                  </li>
                );
              })
            )}
          </ul>
        </section>
      </div>
    );
  }

  return (
    <aside className="search-panel">
      <div className="search-panel-input">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onSearch();
            if (e.key === 'Escape') setQuery('');
          }}
          placeholder={`Search (${formatShortcut(['Mod', 'Shift', 'F'])})`}
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => void onSearch()}
          disabled={searching || query.trim() === ''}
        >
          {searching ? '…' : 'Search'}
        </button>
      </div>
      <div className="search-panel-toggles">
        <label>
          <input
            type="checkbox"
            checked={useRegex}
            onChange={(e) => setUseRegex(e.target.checked)}
          />
          regex
        </label>
        <label>
          <input
            type="checkbox"
            checked={caseInsensitive}
            onChange={(e) => setCaseInsensitive(e.target.checked)}
          />
          case-insensitive
        </label>
      </div>
      {error && <div className="search-panel-error">error: {error}</div>}
      {results !== null && !error && (
        <div className="search-panel-meta">
          {results.length === 0
            ? 'no matches'
            : `${results.length} match${results.length === 1 ? '' : 'es'}`}
        </div>
      )}
      {results !== null && results.length > 0 && (
        <ul className="search-panel-results">
          {results.map((m, i) => (
            <li
              key={`${m.path}:${m.line}:${i}`}
              className="search-panel-result"
              onClick={() => onResultOpen(m.path, m.line)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onResultOpen(m.path, m.line);
              }}
            >
              <span className="search-panel-line">{m.line}</span>
              <span className="search-panel-path">{m.path}</span>
              <span className="search-panel-content">{m.content}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
