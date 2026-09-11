// Trylo Desktop — GitDiffView (P2-1, spec §7.7 / §9.6).
//
// Right-panel Monaco diff of a REAL Git HEAD -> worktree diff (provided by
// the host's GitService.fileDiff). It never loads content itself and never
// IPC's — the host passes the resolved `GitFileDiff`. Binary / oversized
// content degrades to an explicit message instead of streaming bytes into
// the WebView.
//
// C-Edge P2-4: Escape and the close button restore focus to the
// element that originally opened the diff. Tests depend on this.

import { useEffect, useRef, type ReactElement } from 'react';
import { captureFocus, restoreFocus } from '../../a11y/focus-return';

export interface GitFileDiffData {
  readonly original: string;
  readonly modified: string;
  readonly binary: boolean;
  readonly truncated: boolean;
}

export interface GitDiffViewProps {
  readonly path: string;
  /** null while a diff load is in flight; undefined pushes an error state. */
  readonly diff?: GitFileDiffData;
  /** Human-readable load-failure message (kept local to the diff, never
   *  crashing the dock). */
  readonly error?: string;
  readonly onClose: () => void;
}

export function GitDiffView(props: GitDiffViewProps): ReactElement {
  const { diff, error, path, onClose } = props;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Snapshot the focus owner at mount; the close path restores it.
    captureFocus();
    const container = containerRef.current;
    if (!container) return undefined;
    let cancelled = false;
    let diffEditor: import('monaco-editor').editor.IStandaloneDiffEditor | null = null;
    let originalModel: import('monaco-editor').editor.ITextModel | null = null;
    let modifiedModel: import('monaco-editor').editor.ITextModel | null = null;

    if (!diff || diff.binary || diff.truncated) return undefined;

    (async () => {
      const monacoNs = await import('monaco-editor');
      if (cancelled || !container) return;
      originalModel = monacoNs.editor.createModel(diff.original, 'plaintext');
      modifiedModel = monacoNs.editor.createModel(diff.modified, 'plaintext');
      diffEditor = monacoNs.editor.createDiffEditor(container, {
        renderSideBySide: true,
        automaticLayout: true,
        readOnly: true,
        minimap: { enabled: false },
      });
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    })().catch(() => { /* surface nothing; close still works */ });

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        restoreFocus();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      document.removeEventListener('keydown', onKey);
      if (diffEditor) diffEditor.dispose();
      if (originalModel) originalModel.dispose();
      if (modifiedModel) modifiedModel.dispose();
    };
  }, [diff, onClose]);

  const handleClose = (): void => {
    restoreFocus();
    onClose();
  };

  const degraded =
    error !== undefined
    || diff === undefined
    || diff.binary
    || diff.truncated;

  return (
    <div className="git-diff-view" role="region" aria-label={`Diff for ${path}`}>
      <div className="git-diff-view__head">
        <span className="git-diff-view__path" title={path}>{path}</span>
        <button
          type="button"
          className="git-diff-view__close"
          onClick={handleClose}
          aria-label="Close diff"
        >
          ×
        </button>
      </div>
      <div className="git-diff-view__body">
        {error !== undefined && (
          <p className="git-diff-view__degraded" role="status">
            Could not load the Git diff for this change.
          </p>
        )}
        {diff?.binary && (
          <p className="git-diff-view__degraded" role="status">
            Binary file — diff not shown.
          </p>
        )}
        {diff?.truncated && (
          <p className="git-diff-view__degraded" role="status">
            File too large to diff; content not shown.
          </p>
        )}
        {!degraded && <div ref={containerRef} className="git-diff-view__monaco" />}
      </div>
    </div>
  );
}
