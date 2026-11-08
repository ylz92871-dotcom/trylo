// Trylo Desktop — FilePeek (right rail). See
// docs/spikes/phase-2-ui-redesign.md §4.2.
//
// The right rail is the "code on demand" surface. Default
// closed. Opens when a file is referenced in the chat (or
// via a manual "peek" button in v1.4).
//
// Base capability: this panel serves BOTH Code and Work modes —
// file-tree clicks, Code result opens, and Work artifact opens all
// land here via App.onSelectFile. The body is delegated to
// `../preview/PreviewRouter`, so a new format in the preview matrix
// upgrades both modes with no caller changes.
//
// Width: dragged via the RailResizer in AppShell (`width` prop),
// 480px by default. `expanded` is the one-click full preview — CSS
// takes the rail wide and every renderer refits (they all observe
// their container). Untoggling restores the dragged width.

import type { CSSProperties, ReactElement } from 'react';
import { Component, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Copy, ChevronLeft, ChevronRight, ExternalLink, FileText, FolderOpen, MoreHorizontal, Maximize2, Minimize2, RotateCw, X } from 'lucide-react';
import { createTryloHostAdapter } from '../work/tryloHostAdapter';
import { invalidateOfficePages } from '../../host-adapter/preview/office-pages';
import { PreviewFailure } from '../preview/PreviewFailure';
import { isTauri } from '../../host-adapter/tauri-detect';
import type { FilePath } from '../../host-adapter/types';
import { PreviewRouter, previewKindFor, previewKindLabel } from '../preview';
import type { PreviewKind } from '../../preview/formats';

export interface FilePeekProps {
  readonly path: FilePath;
  readonly content: string;
  readonly resolvedKind?: PreviewKind;
  readonly loading?: boolean;
  readonly error?: string;
  readonly allowedRoot?: string;
  readonly onReload?: () => void;
  readonly files?: readonly { readonly path: string; readonly name?: string }[];
  readonly onSelectFile?: (path: string) => void;
  /** Dragged rail width (px). Ignored while `expanded`. */
  readonly width?: number;
  readonly embedded?: boolean;
  readonly expanded?: boolean;
  readonly onToggleExpanded?: () => void;
  readonly onClose: () => void;
}

export function FilePeek(props: FilePeekProps): ReactElement {
  const [revision, setRevision] = useState(0);
  const [actionError, setActionError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent): void => { if (!actionsRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  const [busy, setBusy] = useState(false);
  const host = useMemo(() => props.allowedRoot ? createTryloHostAdapter(props.allowedRoot) : undefined, [props.allowedRoot]);
  const nativeActions = isTauri();
  useEffect(() => { setActionError(''); setRevision(0); setMenuOpen(false); }, [props.path, props.allowedRoot]);
  const action = async (run: () => Promise<void>): Promise<void> => {
    setMenuOpen(false); setActionError(''); setBusy(true);
    try { await run(); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const kind = props.resolvedKind ?? previewKindFor(props.path);
  const expanded = props.expanded === true;
  const fileIndex = props.files?.findIndex((file) => file.path.replace(/\\/g, '/') === props.path.replace(/\\/g, '/')) ?? -1;
  const multiple = !!props.files && props.files.length > 1 && !!props.onSelectFile;
  const style: CSSProperties | undefined =
    !expanded && props.width !== undefined ? { width: props.width } : undefined;
  // Fullscreen exits on Escape — same key users expect from any
  // lightbox / viewer. The chat's own Escape handlers live on menu
  // elements and don't conflict (this only fires while expanded).
  const onToggleExpanded = props.onToggleExpanded;
  useEffect(() => {
    if (!expanded || !onToggleExpanded) return undefined;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onToggleExpanded();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded, onToggleExpanded]);
  return (
    <aside
      className={expanded ? 'file-peek file-peek--expanded' : 'file-peek'}
      aria-label="File preview"
      style={style}
    >
      <header className="file-peek__header">
        <div className="file-peek__path" title={props.path}>
          <FileText size={17} strokeWidth={1.6} aria-hidden="true" />{multiple ? <select className="file-peek__file-select" aria-label="成果文件" value={fileIndex < 0 ? props.path : props.files?.[fileIndex]?.path} onChange={event => props.onSelectFile?.(event.target.value)}>
            {fileIndex < 0 && <option value={props.path}>{props.path.replace(/\\/g, "/").split("/").at(-1)}</option>}
            {props.files?.map(file => <option key={file.path} value={file.path}>{file.name ?? file.path.replace(/\\/g, '/').split('/').at(-1)}</option>)}
          </select> : <span className="file-peek__path-text">{props.path.replace(/\\/g, '/').split('/').at(-1)}</span>}
        </div>
        <span className="file-peek__kind" title={previewKindLabel(kind)}>{multiple && fileIndex >= 0 ? `${fileIndex < 0 ? "–" : fileIndex + 1} / ${props.files?.length}` : previewKindLabel(kind)}</span>
        <button type="button" className="file-peek__expand" title="重新加载" aria-label="Reload preview"
          onClick={() => { if (props.allowedRoot) invalidateOfficePages(props.path, props.allowedRoot); setRevision((n) => n + 1); props.onReload?.(); }}><RotateCw size={15} /></button>
        {host && <div ref={actionsRef} className="file-peek__actions" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false); }} onKeyDown={event => { if (event.key === 'Escape' && menuOpen) { event.stopPropagation(); setMenuOpen(false); event.currentTarget.querySelector('button')?.focus(); } }}>
          <button type="button" className="file-peek__expand" title="文件操作" aria-label="文件操作" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={16} /></button>
          {menuOpen && <div className="file-peek__menu" aria-label="文件操作列表">
          {multiple && <div className="file-peek__menu-nav">
            <button type="button" aria-label="上一个文件" disabled={fileIndex <= 0} onClick={() => { const file = props.files?.[fileIndex - 1]; if (file) { props.onSelectFile?.(file.path); setMenuOpen(false); } }}><ChevronLeft size={15} />上一个文件</button>
            <button type="button" aria-label="下一个文件" disabled={fileIndex < 0 || fileIndex >= (props.files?.length ?? 0) - 1} onClick={() => { const file = props.files?.[fileIndex + 1]; if (file) { props.onSelectFile?.(file.path); setMenuOpen(false); } }}><ChevronRight size={15} />下一个文件</button>
          </div>}
          <button type="button" className="file-peek__expand" title={nativeActions ? '复制文件路径' : '在桌面应用中可用'} aria-label="Copy file path" disabled={busy || !nativeActions} onClick={() => void action(() => host.copyToClipboard(props.path))}><Copy size={15} />复制文件路径</button>
          <button type="button" className="file-peek__expand" title={nativeActions ? '在文件夹中显示' : '在桌面应用中可用'} aria-label="Show in folder" disabled={busy || !nativeActions} onClick={() => void action(() => host.showInFolder(props.path))}><FolderOpen size={15} />在文件夹中显示</button>
          <button type="button" className="file-peek__expand" title={nativeActions ? '使用外部应用打开' : '在桌面应用中可用'} aria-label="Open externally" disabled={busy || !nativeActions} onClick={() => void action(() => host.openFile(props.path))}><ExternalLink size={15} />使用外部应用打开</button>
          </div>}
        </div>}
        {props.onToggleExpanded && (!props.embedded || expanded) && (
          <button
            type="button"
            className="file-peek__expand"
            onClick={props.onToggleExpanded}
            title={expanded ? 'Exit fullscreen' : 'Fullscreen preview'}
            aria-label={expanded ? 'Exit fullscreen' : 'Fullscreen preview'}
            aria-pressed={expanded}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}
        <button
          type="button"
          className="file-peek__close"
          onClick={props.onClose}
          title="Close"
          aria-label="Close file preview"
        >
          <X size={15} />
        </button>
      </header>
      {actionError && <div className="file-peek__meta" role="alert">{actionError}</div>}
      <div className="file-peek__viewer">
        {props.loading ? <div className="preview__empty" role="status"><span className="preview__spinner" />正在读取文件…</div>
          : props.error ? <PreviewFailure error={props.error} />
          : <PreviewBoundary key={`${props.allowedRoot ?? ''}\0${props.path}:${revision}`}><PreviewRouter path={props.path} content={props.content} resolvedKind={kind} allowedRoot={props.allowedRoot} onOpenFile={props.onSelectFile} onOpenExternal={host && nativeActions ? (url) => { void action(() => host.openFile(url)); } : undefined} /></PreviewBoundary>}
      </div>
    </aside>
  );
}

class PreviewBoundary extends Component<{ children: ReactNode }, { error: string }> {
  override state = { error: '' };
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  override render(): ReactNode {
    return this.state.error ? <PreviewFailure error={this.state.error}><p>请重试或使用外部应用打开。</p></PreviewFailure> : this.props.children;
  }
}
