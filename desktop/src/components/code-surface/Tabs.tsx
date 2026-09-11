// Trylo Desktop — Tabs. See the architecture doc §3 Phase 1
// Week 1 Day 2 (Tabs).
//
// Tab strip UI: a list of open file paths rendered as a row of
// tabs above the editor. Click to make a tab active; click the X
// to close it. The active tab drives the editor's "current file"
// (filename in the header, future: per-buffer bridge).
//
// Week 1 Day 2 scope: pure UI. The editor still shows the
// spike's single file. A future Day adds a per-file
// EditorBridge so switching tab also swaps the editor's
// underlying buffer.

import { type ReactElement } from 'react';
import type { FilePath } from '../../host-adapter';
import './Tabs.css';

export interface TabsProps {
  /** All open tabs in display order (left to right). */
  readonly openFiles: readonly FilePath[];
  /** Currently active tab. */
  readonly activeFile: FilePath | null;
  /** Called when the user clicks a tab. */
  readonly onSelect: (path: FilePath) => void;
  /** Called when the user clicks the close button on a tab. */
  readonly onClose: (path: FilePath) => void;
}

function basename(path: FilePath): string {
  // Handle both forward and back slashes for the basename. On
  // Windows paths look like "C:\work\trylo\README.md"; on
  // posix-style it's "C:/work/demo-ws/README.md".
  const m = path.match(/[^/\\]+$/);
  return m ? m[0] : path;
}

export function Tabs({ openFiles, activeFile, onSelect, onClose }: TabsProps): ReactElement {
  if (openFiles.length === 0) {
    return (
      <div className="tabs tabs--empty" aria-label="Open tabs">
        <span className="tabs-empty-msg">No open files</span>
      </div>
    );
  }
  return (
    <div className="tabs" role="tablist" aria-label="Open tabs">
      {openFiles.map((path) => {
        const isActive = path === activeFile;
        return (
          <div
            key={path}
            role="tab"
            aria-selected={isActive}
            className={'tab' + (isActive ? ' tab--active' : '')}
          >
            <button
              type="button"
              className="tab-label"
              onClick={() => onSelect(path)}
              title={path}
            >
              {basename(path)}
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${basename(path)}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
