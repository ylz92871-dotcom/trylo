// Trylo Desktop — RightRail. v1.17.
//
// The file tree, formerly crammed into the left rail's middle
// section, now lives here: a toggleable right-side panel. This
// is "Option A" from the UI redesign — keep the left rail
// focused on workspaces + conversation history, and give the
// file tree its own collapsible home so it doesn't fight for
// vertical space with the session list.
//
// The tree itself is the existing WorkspaceTree component, so
// behaviour (lazy loading, refresh, error states) is unchanged.

import { type ReactElement } from 'react';
import { FolderTree, X } from 'lucide-react';
import type { FilePath } from '../../host-adapter/types';
import { WorkspaceTree } from './WorkspaceTree';

export interface RightRailProps {
  /** Whether the panel is visible. When false, render nothing. */
  readonly open: boolean;
  /** The workspace root whose files are shown. */
  readonly root: FilePath | null;
  /** Hide the panel. */
  readonly onClose: () => void;
  /** Click a file/folder in the tree. */
  readonly onSelectFile?: (path: FilePath, kind: 'file' | 'dir') => void;
}

export function RightRail(props: RightRailProps): ReactElement | null {
  if (!props.open) return null;

  return (
    <aside className="right-rail" aria-label="Workspace files">
      <div className="right-rail__header">
        <span className="right-rail__title">
          <FolderTree size={12} strokeWidth={2.2} aria-hidden="true" />
          <span>Files</span>
        </span>
        <button
          type="button"
          className="right-rail__close"
          onClick={props.onClose}
          title="Hide file tree"
          aria-label="Hide file tree"
        >
          <X size={13} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
      <div className="right-rail__body">
        {props.root ? (
          <WorkspaceTree root={props.root} onSelect={props.onSelectFile} />
        ) : (
          <div className="right-rail__empty">No workspace open.</div>
        )}
      </div>
    </aside>
  );
}
