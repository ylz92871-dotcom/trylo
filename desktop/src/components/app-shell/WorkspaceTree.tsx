// Trylo Desktop — WorkspaceTree.
//
// v1.15.6:
//   - Root (workspace path) is now a clickable toggle:
//     clicking it expands / collapses the whole tree.
//   - Added a "Refresh" button so the user can re-fetch
//     the listing when something looks stale (or after
//     opening a new folder if the auto-reload didn't fire).
//   - Errors from listDir are shown prominently, not
//     silently swallowed. The previous v1.15 layout put
//     errors in a tiny ink-mute line; the user couldn't
//     tell why the tree was empty.
//
// v1.15.4: rewritten so sub-directories can actually be
// expanded. v1.11 rendered the first level but made each
// child node's onToggle a no-op.

import { useEffect, useState, type ReactElement } from 'react';
import { RefreshCw } from 'lucide-react';
import { hostAdapter } from '../../host-adapter';
import type { FilePath } from '../../host-adapter/types';

export interface WorkspaceTreeProps {
  readonly root: FilePath;
  /** Called when the user clicks a file/folder. */
  readonly onSelect?: (path: FilePath, kind: 'file' | 'dir') => void;
}

interface Entry {
  readonly name: string;
  readonly path: FilePath;
  readonly kind: 'file' | 'dir';
}

interface ListResult {
  readonly entries: readonly Entry[];
  readonly error: string | null;
}

async function listDir(path: FilePath): Promise<ListResult> {
  try {
    const entries = await hostAdapter.fs.listDir(path);
    return {
      entries: entries.map((e) => ({
        name: e.name,
        path: e.path as FilePath,
        kind: e.isDirectory ? 'dir' : 'file',
      })),
      error: null,
    };
  } catch (err) {
    return {
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function WorkspaceTree(props: WorkspaceTreeProps): ReactElement {
  const [result, setResult] = useState<ListResult>({ entries: [], error: null });
  // The root-toggle's expanded state is *not* persisted —
  // it's purely a UI affordance. Collapsing it hides the
  // children but doesn't unload them; expanding again
  // re-shows the cached list.
  const [rootCollapsed, setRootCollapsed] = useState(false);
  // Bumped by the Refresh button to force a re-fetch even
  // when props.root hasn't changed.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setResult({ entries: [], error: null });
    listDir(props.root).then((r) => {
      if (!cancelled) setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [props.root, reloadNonce]);

  return (
    <div className="workspace-tree" role="tree" aria-label="Workspace files">
      <div className="workspace-tree__root">
        <button
          type="button"
          className="workspace-tree__root-toggle"
          onClick={() => setRootCollapsed((v) => !v)}
          aria-expanded={!rootCollapsed}
          title={props.root}
        >
          <span className="workspace-tree__root-chev" aria-hidden="true">
            {rootCollapsed ? '▸' : '▾'}
          </span>
          <span className="workspace-tree__root-name">Files</span>
        </button>
        <button
          type="button"
          className="workspace-tree__refresh"
          onClick={() => setReloadNonce((n) => n + 1)}
          title="Re-fetch the directory listing"
          aria-label="Refresh"
        >
          <RefreshCw size={12} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>

      {result.error && (
        <div className="workspace-tree__error" role="alert">
          <strong>Cannot read folder:</strong>
          <span className="workspace-tree__error-msg">{result.error}</span>
          <span className="workspace-tree__error-path">path: {props.root}</span>
        </div>
      )}

      {!result.error && !rootCollapsed && (
        <>
          {result.entries.length === 0 && (
            <div className="workspace-tree__empty">(empty)</div>
          )}
          <ul className="workspace-tree__list">
            {result.entries.map((e) => (
              <TreeNode
                key={e.path}
                entry={e}
                initialExpanded={false}
                onSelect={props.onSelect}
                onPathOpen={listDir}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface TreeNodeProps {
  readonly entry: Entry;
  readonly initialExpanded: boolean;
  readonly onSelect?: (path: FilePath, kind: 'file' | 'dir') => void;
  readonly onPathOpen: (path: FilePath) => Promise<ListResult>;
}

function TreeNode(props: TreeNodeProps): ReactElement {
  const { entry } = props;
  const [expanded, setExpanded] = useState(props.initialExpanded);
  const [children, setChildren] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(false);

  const isDir = entry.kind === 'dir';

  const handleClick = async (): Promise<void> => {
    if (!isDir) {
      props.onSelect?.(entry.path, 'file');
      return;
    }
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      setLoading(true);
      const r = await props.onPathOpen(entry.path);
      setChildren(r);
      setLoading(false);
    }
  };

  return (
    <li
      className="tree-node"
      role="treeitem"
      aria-expanded={isDir ? expanded : undefined}
    >
      <button
        type="button"
        className="tree-node__row"
        onClick={handleClick}
        title={entry.path}
      >
        <span className="tree-node__chevron" aria-hidden="true">
          {isDir ? (expanded ? '▾' : '▸') : '·'}
        </span>
        <span className={`tree-node__icon tree-node__icon--${entry.kind}`}>
          {isDir ? '◫' : '·'}
        </span>
        <span className="tree-node__name">{entry.name}</span>
      </button>
      {isDir && expanded && (
        <ul className="tree-node__children" role="group">
          {loading && <li className="tree-node__loading">…</li>}
          {children?.error && (
            <li className="tree-node__error" role="alert">{children.error}</li>
          )}
          {children?.entries.length === 0 && !loading && !children?.error && (
            <li className="tree-node__empty">(empty)</li>
          )}
          {children?.entries.map((e) => (
            <TreeNode
              key={e.path}
              entry={e}
              initialExpanded={false}
              onSelect={props.onSelect}
              onPathOpen={props.onPathOpen}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
