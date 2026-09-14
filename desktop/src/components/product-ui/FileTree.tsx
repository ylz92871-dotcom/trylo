// Trylo Desktop — FileTree. See ARCHITECTURE.md §3 Phase 1
// Week 1 (File tree + Tabs + Status bar).
//
// Minimal left-panel file tree. Calls `hostAdapter.fs.listDir`
// on demand (the root on mount, subdirs on expand click). The
// spike's EditorBridge is single-file, so `onSelect` here just
// logs to the console — Phase 1 Week 2 wires it to a multi-file
// bridge (one bridge per open buffer).

import { useEffect, useState, type ReactElement } from 'react';
import {
  hostAdapter,
  type DirEntry,
  type FilePath,
} from '../../host-adapter';
import './FileTree.css';

export interface FileTreeProps {
  /** Root of the tree (typically the workspace root). */
  readonly root: FilePath;
  /** Currently-selected file path, for highlight. */
  readonly selectedPath: FilePath | null;
  /** Called when the user clicks a file entry. */
  readonly onSelect: (path: FilePath) => void;
}

interface ExpandedState {
  [path: string]: boolean;
}

export function FileTree({ root, selectedPath, onSelect }: FileTreeProps): ReactElement {
  const [entries, setEntries] = useState<readonly DirEntry[] | null>(null);
  const [expanded, setExpanded] = useState<ExpandedState>({ [root]: true });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-console
        console.log('[filetree] calling listDir for', root);
        const dirs = await hostAdapter.fs.listDir(root);
        // eslint-disable-next-line no-console
        console.log('[filetree] listDir returned', dirs.length, 'entries');
        if (cancelled) return;
        setEntries(dirs);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[filetree] listDir error', err);
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root]);  if (error) {
    return <div className="file-tree-error">list error: {error}</div>;
  }
  if (entries === null) {
    return <div className="file-tree-loading">loading…</div>;
  }

  return (
    <aside className="file-tree" aria-label="File tree">
      <div className="file-tree-header">{root}</div>
      <ul className="file-tree-list">
        {entries.map((entry) => (
          <TreeEntry
            key={entry.path}
            entry={entry}
            depth={0}
            expanded={expanded}
            setExpanded={setExpanded}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </aside>
  );
}

interface TreeEntryProps {
  readonly entry: DirEntry;
  readonly depth: number;
  readonly expanded: ExpandedState;
  readonly setExpanded: React.Dispatch<React.SetStateAction<ExpandedState>>;
  readonly selectedPath: FilePath | null;
  readonly onSelect: (path: FilePath) => void;
}

function TreeEntry(props: TreeEntryProps): ReactElement {
  const { entry, depth, expanded, setExpanded, selectedPath, onSelect } = props;
  const isExpanded = expanded[entry.path] === true;
  const isSelected = selectedPath === entry.path;

  const onClick = (): void => {
    if (entry.isDirectory) {
      setExpanded((prev) => ({ ...prev, [entry.path]: !isExpanded }));
      return;
    }
    onSelect(entry.path);
  };

  return (
    <li>
      <button
        type="button"
        className={
          'file-tree-row' +
          (isSelected ? ' file-tree-row--selected' : '') +
          (entry.isDirectory ? ' file-tree-row--dir' : '')
        }
        style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
        onClick={onClick}
      >
        <span className="file-tree-icon">
          {entry.isDirectory ? (isExpanded ? '▾' : '▸') : ' '}
        </span>
        <span className="file-tree-name">{entry.name}</span>
      </button>
      {entry.isDirectory && isExpanded && (
        <ExpandedDirectory {...props} path={entry.path} depth={depth + 1} />
      )}
    </li>
  );
}

interface ExpandedDirectoryProps extends Omit<TreeEntryProps, 'entry'> {
  readonly path: FilePath;
  readonly depth: number;
}

function ExpandedDirectory(props: ExpandedDirectoryProps): ReactElement {
  const { path, depth, expanded, setExpanded, selectedPath, onSelect } = props;
  const [entries, setEntries] = useState<readonly DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const dirs = await hostAdapter.fs.listDir(path);
        if (cancelled) return;
        setEntries(dirs);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (error) {
    return <div className="file-tree-error" style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}>error: {error}</div>;
  }
  if (entries === null) {
    return <div className="file-tree-loading" style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}>loading…</div>;
  }
  if (entries.length === 0) {
    return <div className="file-tree-empty" style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}>(empty)</div>;
  }
  return (
    <ul className="file-tree-list">
      {entries.map((entry) => (
        <TreeEntry
          key={entry.path}
          entry={entry}
          depth={depth}
          expanded={expanded}
          setExpanded={setExpanded}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
