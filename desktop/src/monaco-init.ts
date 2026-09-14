// Trylo Desktop — Monaco init. See ARCHITECTURE.md §2.4.
//
// Day 2 minimum viable init: bare monaco-editor + workers. We deliberately
// do NOT call `@codingame/monaco-vscode-api`'s `initialize()` here — that
// boots the full VS Code workbench (which the architecture rejects:
// "we draw all of these" in §2.4).
//
// What we DO get from bare monaco-editor:
//   - Monaco editor rendering (the editor itself).
//   - Language services (TypeScript, JSON, CSS, HTML, Markdown, ...).
//   - Textmate grammars + theming.
//   - TS intellisense via ts.worker.
//
// What we LOSE vs. the monaco-vscode-api preset (deferred to later days):
//   - Search service override (ripgrep-backed Ctrl+Shift+F) — Day 6.
//   - File system provider bridge — Day 3.
//   - Keybindings / snippets overrides — Phase 1 polish.
//
// Per ARCHITECTURE.md §2.4 the eventual pattern is:
//   1. Wire monaco-editor's standalone services (this file does that).
//   2. Layer monaco-vscode-api's per-service overrides in narrow form
//      (Search, etc.) where it buys us a real feature. Avoid `Workbench.initialize`.
//   3. Mount our own React UI on top, which talks to the editor via
//      monaco.editor APIs + HostAdapter IPC.

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';

let initPromise: Promise<void> | null = null;

export function initMonaco(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Monaco needs its workers wired before any editor is created. Vite
    // bundles these via `?worker` so the URLs are resolved at build time
    // and the workers load as ES modules in the WebView2 runtime.
    self.MonacoEnvironment = {
      getWorker(_workerId: string, label: string): Worker {
        switch (label) {
          case 'typescript':
          case 'javascript':
            return new TsWorker();
          case 'json':
            return new JsonWorker();
          case 'css':
          case 'scss':
          case 'less':
            return new CssWorker();
          case 'html':
          case 'handlebars':
          case 'razor':
            return new HtmlWorker();
          default:
            return new EditorWorker();
        }
      },
    };

    // monaco-editor's standalone services are set up implicitly the
    // first time `monaco.editor.create` is called. Nothing more to do.
  })();

  return initPromise;
}
