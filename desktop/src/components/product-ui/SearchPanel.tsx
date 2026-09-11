// Trylo Desktop — SearchPanel. See the architecture doc §2.4 (Ctrl+Shift+F
// → ripgrep-backed search service override) + §3 Phase 0 Day 6 +
// Week 2 Day 2 (regex / case toggles + click-to-jump).
//
// Spike scope: substring + optional regex + optional case-
// insensitive. Click a result to open the file (caller wires
// the bridge to make it the active tab).
//
// Ctrl+Shift+F anywhere in the document focuses the input.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { hostAdapter, type FilePath, type SearchMatch } from '../../host-adapter';

export interface SearchPanelProps {
  /** Search root — typically the workspace root. */
  readonly searchRoot: FilePath;
  /** Called when the user clicks a result row. The caller
   *  typically opens the file as a new tab. */
  readonly onResultOpen: (path: FilePath, line: number) => void;
}

export function SearchPanel({ searchRoot, onResultOpen }: SearchPanelProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [caseInsensitive, setCaseInsensitive] = useState(false);
  const [results, setResults] = useState<readonly SearchMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  // Ctrl+Shift+F anywhere → focus the search input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const onSearch = async (): Promise<void> => {
    const q = query.trim();
    if (q === '') {
      setResults(null);
      setError(null);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

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
          placeholder="Search (Ctrl+Shift+F)"
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
