// Trylo Desktop — StatusBar. See ARCHITECTURE.md §3 Phase 1
// Week 1 Day 3 (Status bar).
//
// Bottom-of-editor strip showing cursor position and language.
// Subscribes to the underlying Monaco editor's
// onDidChangeCursorPosition via the imperative ref. Spike scope:
// line:column + language. Week 1 Day 3 finishes Week 1.

import { useEffect, useState, type ReactElement } from 'react';
import type { MonacoEditorRef } from './MonacoEditor';
import './StatusBar.css';

export interface StatusBarProps {
  /** Ref to the Monaco editor. We pull the underlying instance
   *  via `getEditor()` to subscribe to cursor events. */
  readonly editorRef: { current: MonacoEditorRef | null };
  /** Language label (e.g. "Markdown", "TypeScript"). */
  readonly language: string;
}

interface Position {
  readonly line: number;
  readonly column: number;
}

export function StatusBar({ editorRef, language }: StatusBarProps): ReactElement {
  const [position, setPosition] = useState<Position>({ line: 1, column: 1 });

  useEffect(() => {
    const editor = editorRef.current?.getEditor() ?? null;
    if (!editor) return;
    const update = (): void => {
      const pos = editor.getPosition();
      if (pos) {
        setPosition({ line: pos.lineNumber, column: pos.column });
      }
    };
    update();
    const sub = editor.onDidChangeCursorPosition(update);
    return () => sub.dispose();
  }, [editorRef]);

  return (
    <div className="status-bar" aria-label="Status bar">
      <span className="status-bar-item status-bar-pos">
        Ln {position.line}, Col {position.column}
      </span>
      <span className="status-bar-item status-bar-lang">{language}</span>
      <span className="status-bar-item status-bar-fill" />
    </div>
  );
}
