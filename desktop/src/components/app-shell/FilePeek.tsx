// Trylo Desktop — FilePeek (right rail). See
// spike-results/phase-2-ui-redesign.md §4.2.
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
import { useEffect } from 'react';
import type { FilePath } from '../../host-adapter/types';
import { PreviewRouter, previewKindFor, previewKindLabel } from '../preview';

export interface FilePeekProps {
  readonly path: FilePath;
  readonly content: string;
  /** Dragged rail width (px). Ignored while `expanded`. */
  readonly width?: number;
  readonly expanded?: boolean;
  readonly onToggleExpanded?: () => void;
  readonly onClose: () => void;
}

export function FilePeek(props: FilePeekProps): ReactElement {
  const kind = previewKindFor(props.path);
  const lastModified = 'just now'; // Phase 3: real mtime via hostAdapter.fs.statFile
  const expanded = props.expanded === true;
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
          <span className="file-peek__path-text">{props.path}</span>
        </div>
        {props.onToggleExpanded && (
          <button
            type="button"
            className="file-peek__expand"
            onClick={props.onToggleExpanded}
            title={expanded ? 'Exit fullscreen' : 'Fullscreen preview'}
            aria-label={expanded ? 'Exit fullscreen' : 'Fullscreen preview'}
            aria-pressed={expanded}
          >
            {expanded ? '⤡' : '⤢'}
          </button>
        )}
        <button
          type="button"
          className="file-peek__close"
          onClick={props.onClose}
          title="Close"
          aria-label="Close file preview"
        >
          ×
        </button>
      </header>
      <div className="file-peek__meta">
        <span>{previewKindLabel(kind)}</span>
        <span className="file-peek__sep">·</span>
        <span>{lastModified}</span>
      </div>
      <PreviewRouter path={props.path} content={props.content} />
    </aside>
  );
}
