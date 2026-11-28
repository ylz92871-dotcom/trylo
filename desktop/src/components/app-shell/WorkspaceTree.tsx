import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react';
import { ChevronRight, ChevronsDownUp, Folder, FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react';
import { hostAdapter } from '../../host-adapter';
import {
  copyTextToNativeClipboard,
  openWorkspaceEntryWithDefaultApp,
  showNativeContextMenu,
  showWorkspaceEntryInFinder,
} from '../../host-adapter/native-shell';
import { isTauri } from '../../host-adapter/tauri-detect';
import type { FilePath } from '../../host-adapter/types';
import { isMacPlatform } from '../../utils/platform';
import { WorkspaceFileIcon } from './WorkspaceFileIcon';

export interface WorkspaceTreeProps {
  readonly root: FilePath;
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

const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function useDirectory(path: FilePath): {
  result: ListResult | null; refresh: () => void;
} {
  const [result, setResult] = useState<ListResult | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    hostAdapter.fs.listDir(path).then(entries => {
      if (cancelled) return;
      setResult({
        entries: entries.map(e => ({ name: e.name, path: e.path as FilePath, kind: e.isDirectory ? 'dir' as const : 'file' as const }))
          .sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || names.compare(a.name, b.name)),
        error: null,
      });
    }).catch((error: unknown) => {
      if (!cancelled) setResult({ entries: [], error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [path, revision]);
  return { result, refresh: () => setRevision(value => value + 1) };
}

function handleTreeKey(event: KeyboardEvent<HTMLUListElement>): void {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || target.getAttribute('role') !== 'treeitem') return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')]
    .filter(row => !row.closest('[hidden]'));
  const index = rows.indexOf(target);
  const node = target.closest('.tree-node');
  let next: HTMLButtonElement | undefined | null;
  switch (event.key) {
    case 'ArrowDown': next = rows[Math.min(index + 1, rows.length - 1)]; break;
    case 'ArrowUp': next = rows[Math.max(index - 1, 0)]; break;
    case 'Home': next = rows[0]; break;
    case 'End': next = rows.at(-1); break;
    case 'ArrowRight':
      if (target.getAttribute('aria-expanded') === 'false') target.click();
      else if (target.getAttribute('aria-expanded') === 'true') next = node?.querySelector<HTMLButtonElement>(':scope > .tree-node__children > .tree-node > .tree-node__row');
      break;
    case 'ArrowLeft':
      if (target.getAttribute('aria-expanded') === 'true') target.click();
      else next = node?.parentElement?.closest('.tree-node')?.querySelector<HTMLButtonElement>(':scope > .tree-node__row');
      break;
    default: return;
  }
  event.preventDefault();
  next?.focus();
}

interface TreeState {
  readonly root: FilePath;
  readonly selected: FilePath | null;
  readonly focused: FilePath | null;
  readonly collapse: number;
  readonly select: (entry: Entry) => void;
  readonly focus: (path: FilePath) => void;
}

function toRelativeEntryPath(root: string, target: string): string {
  const cleanRoot = root.replace(/[\\/]+$/, '');
  if (target === cleanRoot) return '.';
  if (target.startsWith(`${cleanRoot}/`) || target.startsWith(`${cleanRoot}\\`)) {
    return target.slice(cleanRoot.length + 1);
  }
  return target;
}

function DirectoryStatus({ result, refresh }: { readonly result: ListResult | null; readonly refresh: () => void }): ReactElement | null {
  if (result === null) return <div className="workspace-tree__status" role="status"><LoaderCircle className="workspace-tree__spinner" size={13} aria-hidden="true" />正在加载…</div>;
  if (result.error) return <div className="workspace-tree__error" role="alert"><span>无法读取文件夹</span><span className="workspace-tree__error-msg">{result.error}</span><button type="button" onClick={refresh}><RefreshCw size={12} aria-hidden="true" />重试</button></div>;
  if (result.entries.length === 0) return <div className="workspace-tree__status">此文件夹为空</div>;
  return null;
}

export function WorkspaceTree(props: WorkspaceTreeProps): ReactElement {
  // Workspace changes discard only transient tree state, never host-owned files.
  return <WorkspaceDirectory key={props.root} {...props} />;
}

function WorkspaceDirectory({ root, onSelect }: WorkspaceTreeProps): ReactElement {
  const { result, refresh } = useDirectory(root);
  const [collapsed, setCollapsed] = useState(false);
  const [collapse, setCollapse] = useState(0);
  const [selected, setSelected] = useState<FilePath | null>(null);
  const [focused, setFocused] = useState<FilePath | null>(null);
  const rootName = root.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || root;
  const state: TreeState = {
    root,
    selected, focused, collapse, focus: setFocused,
    select: entry => {
      setSelected(entry.path);
      if (entry.kind === 'file') onSelect?.(entry.path, 'file');
    },
  };
  return <div className="workspace-tree">
    <div className="workspace-tree__root">
      <button type="button" className="workspace-tree__root-toggle" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed} aria-label={`项目文件：${rootName}`} title={root}>
        <ChevronRight className="workspace-tree__root-chev" size={12} aria-hidden="true" />
        <FolderOpen size={15} strokeWidth={1.5} aria-hidden="true" />
        <span className="workspace-tree__root-name">{rootName}</span>
      </button>
      <div className="workspace-tree__actions">
        <button type="button" className="workspace-tree__action" onClick={() => { setCollapse(value => value + 1); setFocused(null); }} aria-label="折叠所有文件夹" title="折叠所有文件夹"><ChevronsDownUp size={15} strokeWidth={1.6} aria-hidden="true" /></button>
        <button type="button" className="workspace-tree__action" onClick={() => { setFocused(null); refresh(); }} disabled={result === null} aria-label="刷新文件" title="刷新文件"><RefreshCw className={result === null ? 'workspace-tree__spinner' : undefined} size={14} strokeWidth={1.6} aria-hidden="true" /></button>
      </div>
    </div>
    <div hidden={collapsed}>
      <DirectoryStatus result={result} refresh={refresh} />
      <ul className="workspace-tree__list" role="tree" aria-label={`${rootName} 文件`} aria-busy={result === null} onKeyDown={handleTreeKey}>
        {result?.entries.map((entry, index) => <TreeNode key={entry.path} entry={entry} depth={1} first={index === 0} state={state} />)}
      </ul>
    </div>
  </div>;
}

interface TreeNodeProps {
  readonly entry: Entry;
  readonly depth: number;
  readonly first?: boolean;
  readonly state: TreeState;
}

function TreeNode({ entry, depth, first, state }: TreeNodeProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState(false);
  const isDir = entry.kind === 'dir';
  useEffect(() => { setExpanded(false); }, [state.collapse]);
  const FolderIcon = expanded ? FolderOpen : Folder;
  const activate = (): void => {
    state.select(entry);
    state.focus(entry.path);
    if (isDir) { setExpanded(value => !value); setOpened(true); }
  };
  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>): void => {
    if (!isMacPlatform() || !isTauri()) return;
    event.preventDefault();
    event.stopPropagation();
    state.select(entry);
    state.focus(entry.path);

    const items = isDir
      ? [
          { id: 'toggle', label: expanded ? '折叠文件夹' : '展开文件夹' },
          { id: 'reveal', label: '在 Finder 中显示' },
          { id: 'sep-1', label: '', separator: true },
          { id: 'copy-rel', label: '复制相对路径' },
          { id: 'copy-abs', label: '复制绝对路径' },
        ]
      : [
          { id: 'preview', label: '预览文件' },
          { id: 'reveal', label: '在 Finder 中显示' },
          { id: 'open-default', label: '用默认应用打开' },
          { id: 'sep-1', label: '', separator: true },
          { id: 'copy-rel', label: '复制相对路径' },
          { id: 'copy-abs', label: '复制绝对路径' },
        ];

    void showNativeContextMenu(items).then((choice) => {
      if (choice === 'preview') {
        state.select(entry);
      } else if (choice === 'toggle') {
        setExpanded((value) => !value);
        setOpened(true);
      } else if (choice === 'reveal') {
        void showWorkspaceEntryInFinder(entry.path, state.root);
      } else if (choice === 'open-default') {
        void openWorkspaceEntryWithDefaultApp(entry.path, state.root);
      } else if (choice === 'copy-rel') {
        void copyTextToNativeClipboard(toRelativeEntryPath(state.root, entry.path));
      } else if (choice === 'copy-abs') {
        void copyTextToNativeClipboard(entry.path);
      }
    });
  };
  return <li className="tree-node" role="none">
    <button type="button" className="tree-node__row" role="treeitem" aria-level={depth} aria-expanded={isDir ? expanded : undefined} aria-selected={state.selected === entry.path}
      tabIndex={state.focused === entry.path || state.focused === null && first ? 0 : -1}
      data-hidden-file={entry.name.startsWith('.') || undefined} onClick={activate} onContextMenu={handleContextMenu} onFocus={() => state.focus(entry.path)} title={entry.path}>
      <span className="tree-node__chevron" aria-hidden="true">{isDir && <ChevronRight size={12} strokeWidth={1.8} />}</span>
      {isDir ? <FolderIcon className="tree-node__icon tree-node__icon--dir" size={16} strokeWidth={1.5} aria-hidden="true" /> : <WorkspaceFileIcon name={entry.name} />}
      <span className="tree-node__name">{entry.name}</span>
    </button>
    {isDir && opened && <DirectoryBranch path={entry.path} depth={depth + 1} expanded={expanded} state={state} />}
  </li>;
}

function DirectoryBranch({ path, depth, expanded, state }: { readonly path: FilePath; readonly depth: number; readonly expanded: boolean; readonly state: TreeState }): ReactElement {
  const { result, refresh } = useDirectory(path);
  return <ul className="tree-node__children" role="group" hidden={!expanded} aria-busy={result === null}>
    {(result === null || result.error || result.entries.length === 0) && <li role="none"><DirectoryStatus result={result} refresh={refresh} /></li>}
    {result?.entries.map(entry => <TreeNode key={entry.path} entry={entry} depth={depth} state={state} />)}
  </ul>;
}
